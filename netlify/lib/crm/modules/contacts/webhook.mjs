// Contacts module: the lead webhook (design §6.7, decision D6).
//
// POST /api/crm/hooks/lead/:token is fed by Zapier ("Facebook Lead Ads →
// New Lead" → "Webhooks by Zapier → POST JSON"), so Meta leads reach the
// CRM without a Meta app review. Tokens are made by an owner (Settings →
// Lead webhooks), shown once, and kept only as a sha256 in
// cfg/intake.webhook_tokens. The token rides in the path (Zapier sends no
// custom auth); the dispatcher logs route patterns, never the real path.
//
// Body: { full_name | first_name + last_name, phone_number, email,
// street_address, city, state, zip_code, form_name, ad_name, campaign_name,
// county | where_are_you_located, notes, id } → intakeLead with
// source.source = the token's source ("Meta Ads"), form, ad, campaign and
// county kept as structured fields, and provider_lead_id = the leadgen id,
// so a Zapier retry or a second delivery is one contact. The answer is
// { ok: true } and nothing more (no contact id, no "created"): a token
// holder can't ask whether a phone number is already on file.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, getSettingWithEtag, putSetting } from "../../../crm-store.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { InputError, NotFoundError, StaleError } from "../../core/errors.mjs";
import { nowIso } from "../../core/clock.mjs";
import { fail } from "../../core/http.mjs";
import { intakeLead } from "./intake.mjs";

export const TOKEN_PREFIX = "blh_";
export const TOKEN_RE = /^blh_[A-Za-z0-9_-]{24,64}$/;
export const HOOK_PATH = "/api/crm/hooks/lead/";
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const str = (v) => (v == null ? "" : String(v)).trim();

export const newHookToken = () => TOKEN_PREFIX + randomBytes(24).toString("base64url");
export const hookUrl = (token) => CANONICAL_ORIGIN + HOOK_PATH + token;

const publicToken = (t) => ({ id: t.id, label: t.label, source: t.source, created_at: t.created_at || null });

// The token entry a token matches, compared in constant time. → entry | null
export function matchToken(tokens, token) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const h = Buffer.from(sha(token), "hex");
  let hit = null;
  for (const t of Array.isArray(tokens) ? tokens : []) {
    if (typeof t.hash !== "string" || t.hash.length !== 64) continue;
    if (timingSafeEqual(Buffer.from(t.hash, "hex"), h)) hit = t;
  }
  return hit;
}

// Zapier's Meta lead (any of the usual field spellings) → the intake input (pure).
export function metaInput(body = {}, source = "Meta Ads") {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const pick = (...keys) => { for (const k of keys) { const v = str(b[k]); if (v) return v; } return ""; };
  const form = pick("form_name", "form"), ad = pick("ad_name", "ad"), campaign = pick("campaign_name", "campaign");
  const county = pick("county", "where_are_you_located", "where_are_you_located?");
  const notes = pick("notes", "message", "comments");
  const lines = [`Meta lead${form ? ` (form: ${form}${ad ? `, ad: ${ad}` : ""})` : ad ? ` (ad: ${ad})` : ""}`];
  if (county) lines.push(`Where: ${county}`);
  if (notes) lines.push(`Notes: ${notes}`);
  const street = pick("street_address", "address", "street");
  return {
    name: pick("full_name", "name"), first_name: pick("first_name"), last_name: pick("last_name"),
    phone: pick("phone_number", "phone"), email: pick("email"),
    address: street || pick("city") || pick("zip_code", "zip", "post_code") ? { street1: street, city: pick("city"), state: pick("state") || "MN", zip: pick("zip_code", "zip", "post_code") } : null,
    source: { source, ...(form ? { form } : {}), ...(ad ? { ad } : {}), ...(campaign ? { campaign } : {}), ...(county ? { county: county.toLowerCase().replace(/\s+county$/, "") } : {}) },
    provider_lead_id: pick("id", "leadgen_id", "lead_id"),
    notes: lines.join("\n"),
    tags: [],
  };
}

// ------------------------------------------------------------ routes

async function hookRoute(ctx) {
  const token = ctx.params.token;
  const cfg = await getSetting("intake");
  const hit = matchToken(cfg.webhook_tokens, token);
  if (!hit) return fail("bad_token", "That webhook link isn't valid.", 401);
  const input = metaInput(ctx.body, hit.source || "Meta Ads");
  const out = await intakeLead(input, { origin: "webhook", by: `hook:lead`, mode: await ctx.sysMode(), requestId: ctx.requestId });
  if (!out.ok) {
    if (out.error === "invalid" || out.error === "no_contact") return fail("invalid", "That lead has no usable phone or email.", 400, { field: out.field || "phone_number" });
    return fail("busy", "Storage didn't answer. Try again in a minute.", 503, { headers: { "Retry-After": "30" } });
  }
  // { ok: true } and nothing else: whoever holds a token must not learn whether a number is on file
  return {};
}

async function listTokens() {
  const cfg = await getSetting("intake");
  return { data: (cfg.webhook_tokens || []).map(publicToken) };
}

// Changes cfg/intake.webhook_tokens by CAS (an owner may be saving the
// intake mode at the same moment).
async function changeTokens(ctx, mutate) {
  for (let i = 0; i < 4; i++) {
    const { data, etag } = await getSettingWithEtag("intake");
    const next = { ...data, webhook_tokens: mutate([...(data.webhook_tokens || [])]) };
    try {
      return await putSetting("intake", next, { ...ctx.write(), ifMatch: etag || "new" });
    } catch (e) {
      if (!(e instanceof StaleError)) throw e;
    }
  }
  throw new StaleError(null, null, "Settings kept changing. Try again.");
}

async function createToken(ctx) {
  const b = ctx.body || {};
  const label = str(b.label).slice(0, 60) || "Meta leads (Zapier)";
  const source = str(b.source).slice(0, 60) || "Meta Ads";
  const token = newHookToken();
  const entry = { id: randomBytes(5).toString("hex"), hash: sha(token), label, source, created_at: nowIso(), created_by: ctx.user.id };
  await changeTokens(ctx, (list) => {
    if (list.length >= 10) throw new InputError("Revoke an old webhook link first (10 at most).", "label");
    return [...list, entry];
  });
  return { status: 201, data: { ...publicToken(entry), token, url: hookUrl(token) } };
}

async function deleteToken(ctx) {
  const id = ctx.params.id;
  let found = false;
  await changeTokens(ctx, (list) => list.filter((t) => { if (t.id === id) { found = true; return false; } return true; }));
  if (!found) throw new NotFoundError("That webhook link isn't there.");
  return { data: { ok: true } };
}

export const webhookRoutes = [
  { method: "POST", path: "/hooks/lead/:token", auth: "hook", perm: null, subject: "none", mode: "inline", idempotent: false, maxBody: 32 * 1024, maxCalls: 80, handler: hookRoute },
  { method: "GET", path: "/intake/webhook-tokens", auth: "session", perm: "settings:owner", subject: "none", mode: "inline", handler: listTokens },
  { method: "POST", path: "/intake/webhook-tokens", auth: "session", perm: "settings:owner", subject: "none", mode: "inline", secret: true, idempotent: false, handler: createToken },
  { method: "DELETE", path: "/intake/webhook-tokens/:id", auth: "session", perm: "settings:owner", subject: "required", mode: "inline", handler: deleteToken },
];
