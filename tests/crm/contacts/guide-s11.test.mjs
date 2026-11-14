// The Rotor guide's Customers and Leads gaps (guide-gaps S11, S11b, S11c,
// S12, S13): the index row's new keys (lead stage, muted, converted), a lead
// stage set by hand and derived until then, the Customers list's Select
// (bulk), the contact's Files card and "Open their portal" (a 15-minute
// office look that pays, changes and counts nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const T = await import("../../../netlify/lib/crm/modules/contacts/types.mjs");
const L = await import("../../../netlify/lib/crm/modules/contacts/leadstage.mjs");
const B = await import("../../../netlify/lib/crm/modules/contacts/bulk.mjs");

const PDF = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

test("lead stages: Rotor's seven, Rotor's words mapped, derived until set by hand", () => {
  assert.deepEqual(L.LEAD_STAGES, ["new", "contacted", "quoted", "follow_up", "sold", "not_interested", "not_ready"]);
  assert.equal(L.rotorStage("Follow-Up"), "follow_up");
  assert.equal(L.rotorStage("Not Interested"), "not_interested");
  assert.equal(L.rotorStage("Something else"), null);
  assert.equal(L.deriveLeadStage({ lc: "lead" }), "new");
  assert.equal(L.deriveLeadStage({ lc: "lead", slc: "2026-11-01T10:00:00Z" }), "contacted");
  assert.equal(L.deriveLeadStage({ lc: "lead", lca: "2026-11-01T10:00:00Z", oq: true }), "quoted");
  assert.equal(L.deriveLeadStage({ lc: "lead" }, { enrollment: { cad: "estimate_follow_up" } }), "follow_up");
  assert.equal(L.deriveLeadStage({ lc: "lead" }, { deal: { st: "lost" } }), "not_interested");
  assert.equal(L.deriveLeadStage({ lc: "customer" }), "sold");
  assert.equal(L.deriveLeadStage({ lc: "lead", oq: true, lst: "not_ready" }), "not_ready", "by hand wins");
});

test("the record and the index row: lst, lsa, mu, cva; nothing when there is nothing", () => {
  const base = T.contactType.example();
  const row = T.contactRow(base);
  for (const k of ["lst", "lsa", "mu", "cva"]) assert.equal(k in row, false, k);
  assert.throws(() => T.validateContact({ ...base, lead_stage: "hot" }, { op: "create" }), /choices/);
  const v = T.validateContact({ ...base, lead_stage: "quoted" }, { op: "update", before: base });
  assert.equal(v.lead_stage, "quoted");
  assert.ok(v.lead_stage_at, "the time it moved");
  const r = T.contactRow({ ...v, automations_paused: { sms: { reason: "x" } }, converted_at: "2026-11-02T10:00:00Z" });
  assert.equal(r.lst, "quoted");
  assert.equal(r.lsa, v.lead_stage_at);
  assert.equal(r.mu, 1);
  assert.equal(r.cva, "2026-11-02T10:00:00Z");
  assert.equal(T.contactRow({ ...base, rotor: { stage: "Contacted" } }).lst, "contacted", "Rotor's stage from the import");
  const conv = T.validateContact({ ...base, lifecycle: "customer" }, { op: "update", before: { ...base, lifecycle: "lead" } });
  assert.ok(conv.converted_at, "a lead that becomes a customer is stamped");
});

test("applyBulk (pure): each action, and no change when already so", () => {
  const c = { id: "ct_x", tags: ["Website"], lifecycle: "lead" };
  assert.deepEqual(B.applyBulk(c, "tag", "VIP").tags, ["Website", "VIP"]);
  assert.equal(B.applyBulk(c, "tag", "website"), null, "case-blind");
  assert.deepEqual(B.applyBulk(c, "untag", "website").tags, []);
  assert.equal(B.applyBulk(c, "owner", ""), null);
  assert.equal(B.applyBulk(c, "lead_stage", "quoted", { at: "t" }).lead_stage_by_hand, true);
  assert.equal(B.applyBulk({ ...c, lifecycle: "archived" }, "archive", "spam"), null);
  assert.throws(() => B.applyBulk({ ...c, merged_into: "ct_y" }, "tag", "VIP"), /merged/);
});

test("PATCH lead_stage, POST /contacts/bulk, files, portal view (and a tech is refused each)", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    const mk = async (n) => {
      const r = await t.api("/contacts", { method: "POST", as: owner, body: { first_name: "Pat", last_name: "Bulk" + n, phone: "76355502" + String(n).padStart(2, "0"), force: true } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { id: r.body.data.contact.id, etag: r.headers.get("etag") };
    };
    const a = await mk(1), b = await mk(2), c = await mk(3);
    // the stage by hand, then back to derived
    let p = await t.api(`/contacts/${a.id}`, { method: "PATCH", as: owner, ifMatch: a.etag, body: { lead_stage: "not_ready" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.contact.lead_stage, "not_ready");
    assert.equal(p.body.data.contact.lead_stage_by_hand, true);
    assert.equal((await t.api(`/contacts/${a.id}`, { method: "PATCH", as: owner, ifMatch: p.headers.get("etag"), body: { lead_stage: "hot" } })).status, 400);
    let ix = await t.api("/contacts/index", { as: owner });
    assert.equal(ix.body.data.rows.find((x) => x.id === a.id).lst, "not_ready");
    p = await t.api(`/contacts/${a.id}`, { method: "PATCH", as: owner, ifMatch: p.headers.get("etag"), body: { lead_stage: null } });
    assert.equal(p.status, 200);
    assert.equal(p.body.data.contact.lead_stage, undefined, "back to the derived stage");
    // bulk: tag three (one twice), owner, stage; a bad value is refused whole; too many refused
    let r = await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [a.id, b.id, c.id, a.id], action: "tag", value: "Spring list" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.done, 3);
    r = await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [a.id, b.id], action: "tag", value: "spring list" } });
    assert.equal(r.body.data.done, 0);
    assert.equal(r.body.data.skipped.length, 2, "already tagged: skipped");
    r = await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [a.id], action: "owner", value: owner.id } });
    assert.equal(r.body.data.done, 1);
    r = await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [b.id], action: "lead_stage", value: "quoted" } });
    assert.equal(r.body.data.done, 1);
    assert.equal((await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [a.id], action: "owner", value: "us_nope" } })).status, 400);
    assert.equal((await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [a.id], action: "explode" } })).status, 400);
    assert.equal((await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: Array.from({ length: 201 }, (_, i) => a.id.slice(0, -3) + String(i).padStart(3, "0")), action: "tag", value: "x" } })).status, 400);
    assert.equal((await t.api("/contacts/bulk", { method: "POST", as: tech, body: { ids: [a.id], action: "tag", value: "x" } })).status, 403);
    ix = await t.api("/contacts/index", { as: owner });
    const rowA = ix.body.data.rows.find((x) => x.id === a.id);
    assert.deepEqual(rowA.tg, ["Spring list"]);
    assert.equal(rowA.o, owner.id);
    assert.equal(ix.body.data.rows.find((x) => x.id === b.id).lst, "quoted");
    r = await t.api("/contacts/bulk", { method: "POST", as: owner, body: { ids: [c.id], action: "archive", value: "test" } });
    assert.equal(r.body.data.done, 1);
    ix = await t.api("/contacts/index", { as: owner });
    assert.equal(ix.body.data.rows.find((x) => x.id === c.id).lc, "archived");
    // files: upload through the shared route, list on the contact, a tech can't
    const up = await t.api(`/files?owner_type=contact&owner_id=${a.id}&kind=document`, { method: "POST", as: owner, raw: PDF(), headers: { "content-type": "application/pdf" } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const fl = await t.api(`/contacts/${a.id}/files`, { as: owner });
    assert.equal(fl.status, 200);
    assert.equal(fl.body.data.length, 1);
    assert.equal(fl.body.data[0].content_type, "application/pdf");
    assert.equal((await t.api(`/contacts/${a.id}/files`, { as: tech })).status, 403);
    // the portal, as they see it: a short single-use hub link, refused for an archived contact and for a tech
    const pv = await t.api(`/contacts/${a.id}/portal-view`, { method: "POST", as: owner, body: {} });
    assert.equal(pv.status, 201, JSON.stringify(pv.body));
    assert.match(pv.body.data.url, /\/p\/[0-9A-Za-z]{10}$/);
    assert.equal(Date.parse(pv.body.data.expires_at) - Date.parse("2026-11-17T15:00:00Z"), 15 * 60000);
    const code = pv.body.data.url.split("/p/")[1];
    const core = await import("../../../netlify/lib/crm/portal/core.mjs");
    const link = await core.readLink(code);
    assert.equal(link.office_view, true);
    assert.equal(link.single_use, true);
    assert.equal(link.scope.kind, "hub");
    assert.equal((await t.api(`/contacts/${c.id}/portal-view`, { method: "POST", as: owner, body: {} })).status, 409);
    assert.equal((await t.api(`/contacts/${a.id}/portal-view`, { method: "POST", as: tech, body: {} })).status, 403);
  } finally { t.done(); }
});
