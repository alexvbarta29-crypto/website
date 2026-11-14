// Budget samples for the contacts routes (read by tests/crm/core/budget.test.mjs):
// "METHOD /path" → (fx) → the request. Each sample makes what it needs
// through the store first (synthetic people only).
import { createHash } from "node:crypto";

const store = await import("../../../netlify/lib/crm-store.mjs");
const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let n = 0;
const fresh = (extra = {}) => scope(async () => {
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Budget", last_name: `Person${n}`, phones: [{ e164: `+1763555${String(300 + n).padStart(4, "0")}` }],
    emails: [{ address: `budget${n}@example.com` }], lifecycle: "lead", source: { source: "Other" },
    billing_address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...extra,
  }, W)).data;
});
const etagOf = (type, id) => scope(async () => (await store.getRecord(type, id)).etag);
const property = (cid) => scope(async () => (await store.createRecord("property", { contact_id: cid, label: "Home", address: { street1: "1 Budget Ave", city: "Delano", state: "MN", zip: "55328" } }, W)).data);
const candidate = async () => {
  const a = await fresh();
  const b = await fresh();
  const { createCandidate } = await import("../../../netlify/lib/crm/modules/contacts/match.mjs");
  return scope(() => createCandidate(a.id, b.id, { reason: "phone", confidence: "high" }, W));
};
const TOKEN = "blh_budgetbudgetbudgetbudgetbudget01";
const token = () => scope(async () => {
  const { data, etag } = await store.getSettingWithEtag("intake");
  if ((data.webhook_tokens || []).some((t) => t.id === "budget1")) return;
  await store.putSetting("intake", { ...data, webhook_tokens: [{ id: "budget1", hash: createHash("sha256").update(TOKEN).digest("hex"), label: "Budget", source: "Meta Ads" }] }, { ...W, ifMatch: etag || "new" });
});

export default {
  "GET /contacts/index": (fx) => ({ as: fx.owner, path: "/contacts/index" }),
  "GET /contacts": (fx) => ({ as: fx.owner, path: "/contacts?q=budget" }),
  "POST /contacts": (fx) => ({ as: fx.owner, path: "/contacts", body: { first_name: "Budget", last_name: "New", phone: "7635550399", email: "budget.new@example.com", address: { street1: "399 Example Ave", city: "Delano", state: "MN", zip: "55328" }, force: true } }),
  "GET /contacts/:id": async (fx) => { const c = await fresh(); await property(c.id); return { as: fx.owner, path: `/contacts/${c.id}` }; },
  "PATCH /contacts/:id": async (fx) => { const c = await fresh(); return { as: fx.owner, path: `/contacts/${c.id}`, ifMatch: await etagOf("contact", c.id), body: { last_name: "Edited", phones: [{ e164: "7635550398" }], tags: ["Budget"] } }; },
  "POST /contacts/:id/archive": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/archive`, body: { reason: "spam" } }),
  "POST /contacts/:id/restore": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh({ lifecycle: "archived", archived_reason: "spam" })).id}/restore`, body: {} }),
  "GET /contacts/:id/activity": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/activity` }),
  "POST /contacts/:id/notes": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/notes`, body: { text: "A budget note." } }),
  "PATCH /contacts/:id/consent": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/consent`, body: { channel: "sms_marketing", state: "revoked" } }),
  "PATCH /contacts/:id/automations-paused": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/automations-paused`, body: { channel: "sms", paused: true, reason: "Calls only" } }),
  "PATCH /contacts/:id/flags": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/flags`, body: { test: true } }),
  "GET /contacts/:id/properties": async (fx) => { const c = await fresh(); await property(c.id); return { as: fx.owner, path: `/contacts/${c.id}/properties` }; },
  "POST /contacts/:id/properties": async (fx) => ({ as: fx.owner, path: `/contacts/${(await fresh()).id}/properties`, body: { label: "Cabin", address: { street1: "9 Lake Rd", city: "Mound", state: "MN", zip: "55364" } } }),
  "GET /properties/:id": async (fx) => ({ as: fx.owner, path: `/properties/${(await property((await fresh()).id)).id}` }),
  "PATCH /properties/:id": async (fx) => { const p = await property((await fresh()).id); return { as: fx.owner, path: `/properties/${p.id}`, ifMatch: await etagOf("property", p.id), body: { access: { gate_code: "1234" }, assets: { windows: { standard: 20, slider: 6, french: 5 }, windows_int: { standard: 18 }, panes_ext: 34, panes_int: 18, screens: 12, tracks: 8, ladder_ft: 28, notes: "Synthetic: ladder on the back." } } }; },
  "GET /properties/:id/requote": async (fx) => {
    const p = await property((await fresh()).id);
    await scope(() => store.updateRecord("property", p.id, (x) => ({ ...x, assets: { windows: { standard: 20, slider: 6 }, panes_ext: 32, screens: 12, services: ["windows_ext", "screens"], plan: "quarterly" } }), W));
    return { as: fx.owner, path: `/properties/${p.id}/requote` };
  },
  "POST /properties/:id/geocode": async (fx) => ({ as: fx.owner, path: `/properties/${(await property((await fresh()).id)).id}/geocode`, body: {} }),
  "GET /merge-candidates": async (fx) => { await candidate(); return { as: fx.owner, path: "/merge-candidates" }; },
  "POST /merge-candidates/bulk": (fx) => ({ as: fx.owner, path: "/merge-candidates/bulk", body: { action: "dismiss_low", confirm: "DISMISS" } }),
  "POST /merge-candidates/:id/merge": async (fx) => ({ as: fx.owner, path: `/merge-candidates/${(await candidate()).id}/merge`, body: { survivor: "a" } }),
  "POST /merge-candidates/:id/dismiss": async (fx) => ({ as: fx.owner, path: `/merge-candidates/${(await candidate()).id}/dismiss`, body: {} }),
  "POST /contacts/:id/merge": async (fx) => { const a = await fresh(); const b = await fresh(); return { as: fx.owner, path: `/contacts/${a.id}/merge`, body: { other_id: b.id } }; },
  "POST /hooks/lead/:token": async () => { await token(); return { path: `/hooks/lead/${TOKEN}`, csrf: false, body: { full_name: "Budget Meta", phone_number: "+17635550397", email: "budget.meta@example.com", id: "880000000000099", form_name: "Sample Form" } }; },
  "GET /intake/webhook-tokens": (fx) => ({ as: fx.owner, path: "/intake/webhook-tokens" }),
  "POST /intake/webhook-tokens": (fx) => ({ as: fx.owner, path: "/intake/webhook-tokens", body: { label: "Budget link" } }),
  "DELETE /intake/webhook-tokens/:id": async (fx) => { await token(); return { as: fx.owner, path: "/intake/webhook-tokens/budget1" }; },
};
