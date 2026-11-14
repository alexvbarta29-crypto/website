// The contacts screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation is escaped, links that leave the CRM
// open a new tab, and each screen says what it should. The phone walk
// (Playwright) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/contacts/${name}.js`)).default;
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner", first_name: "Olive" }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const NOW = "2026-11-17T15:00:00.000Z";
const XSS = "</script><script>alert(1)</script>";

const contact = {
  id: "ct_00000000000000000001", display_name: `Pat ${XSS}`, first_name: "Pat", last_name: "Example", lifecycle: "customer",
  phones: [{ e164: "+17635550100", label: "mobile", primary: true, sms: true }], emails: [{ address: "pat@example.com", primary: true }],
  billing_address: { street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328" }, tags: ["Website", XSS], notes: `Gate code 1234\n${XSS}`,
  consent: { sms_service: { state: "granted" }, sms_marketing: { state: "revoked" }, email_marketing: { state: "unknown" } },
  source: { source: "Meta Ads", form: "Sample Form", ad: "Sample Ad", county: "wright" }, flags: { vip: true }, created_at: NOW, updated_at: NOW,
  primary_property_id: "pr_00000000000000000001",
};
const property = { id: "pr_00000000000000000001", contact_id: contact.id, label: "Home", address: contact.billing_address, town_tier: "primary", distance_mi: 3.2, access: { gate_code: "1234", pets: "Dog" }, assets: { panes_ext: 24 }, photo_ids: [] };

test("Contacts list: rows, chips, the merge notice; search rules match the server's", async () => {
  const list = await load("list");
  const L = await import("../../../crm-app/modules/contacts/list.js");
  const rows = [
    { id: "ct_1", n: "Ann Able", f: "Ann", l: "Able", lc: "lead", p: ["7635550101"], e: [], c: "Delano", tg: [], src: "Meta Ads" },
    { id: "ct_2", n: "Zed Zane", f: "Zed", l: "Zane", lc: "customer", p: [], e: ["zed@example.com"], c: "Mound", tg: ["VIP"], src: "Website" },
    { id: "ct_3", n: "Old Gone", f: "Old", l: "Gone", lc: "archived", p: [], e: [], c: "", tg: [], src: "" },
  ];
  const h = text(list.render({ ix: { rows }, dupes: 2, q: "", chip: "", src: "", sources: ["Meta Ads"] }, ctx()));
  assert.match(h, /2 possible duplicates to review/);
  assert.match(h, /data-chip="lead"/);
  assert.doesNotMatch(h, /legacy\/customers/, "Rotor's first list is in Settings → Import & data now");
  assert.deepEqual(L.filter(rows, {}).map((r) => r.id), ["ct_1", "ct_2"], "archived hidden");
  assert.deepEqual(L.filter(rows, { q: "555 0101" }).map((r) => r.id), ["ct_1"]);
  assert.deepEqual(L.filter(rows, { chip: "archived" }).map((r) => r.id), ["ct_3"]);
  assert.deepEqual(L.grouped(rows).map((g) => g.l), ["A", "G", "Z"]);
  assert.doesNotMatch(text(list.render({ ix: { rows }, dupes: 0, q: "", chip: "", src: "", sources: [] }, ctx(["contacts:read_all"]))), /possible duplicate/);
});

test("Contact (Rotor's page): the top, Details and Activity, the header's pencil and \"...\"; everything escaped", async () => {
  const c = await load("contact");
  const s = { contact, stats: { contacts: { customer_since: "2025-04-01" }, work: {}, money: {}, plans: {} }, properties: [property], users: [], tech: false, etag: '"1"' };
  const open = { ...ctx(), keep: { about: true } };
  const h = text(c.render(s, open));
  assert.ok(!h.includes("<script>alert(1)"), "names, tags and notes are escaped");
  assert.match(h, /href="tel:\+17635550100"/);
  assert.match(h, /href="sms:\+17635550100"/);
  assert.match(h, /href="mailto:pat@example.com"/);
  assert.match(h, /data-copy="pat@example.com"/, "a round copy on the email");
  assert.match(h, /target="_blank" rel="noopener"|data-external="top"/, "directions leave the frame");
  assert.match(h, /role="tablist"[\s\S]*Details[\s\S]*Activity/, "Details | Activity");
  assert.match(h, /Marketing texts/, "the consent card (Activity)");
  assert.match(h, /Sample Form · Sample Ad/, "About, opened");
  assert.match(h, /Customer since/);
  assert.match(h, /Primary property/i);
  assert.match(h, /data-notes="ct-notes"/, "the notes box");
  assert.match(h, /data-pick-owner/, "the owner pill picks an owner");
  assert.match(text(c.render(s, ctx())), /data-about/, "About folded until asked");
  assert.doesNotMatch(text(c.render(s, ctx())), /Sample Form · Sample Ad/);
  const labels = (perms) => c.more(s, ctx(perms)).flat().filter(Boolean).map((r) => r.label);
  assert.ok(labels().includes("Mark as test contact"));
  assert.ok(labels().includes("Archive") && labels().includes("Merge with...") && labels().includes("Pause automated texts") && labels().includes("Texts and email"));
  assert.ok(!labels(["contacts:read", "contacts:write"]).includes("Mark as test contact"), "owners only");
  assert.deepEqual(c.tools(s, ctx()).filter(Boolean).map((x) => x.href), ["#/contacts/ct_00000000000000000001/edit"], "the round pencil");
  assert.match(c.title(s), /^Pat /, "the header's h1 (out of sight on a phone: the name is the page's own)");
  const act = text(c.render({ ...s, activity: [{ at: NOW, kind: "contact.intake", source: "Website quote form", note: `— Website —\n${XSS}` }, { at: NOW, kind: "note" }] }, ctx()));
  assert.match(act, /Website request \(Website quote form\)/);
  assert.ok(!act.includes("<script>alert(1)"));
  assert.match(h, /href="#\/properties\/pr_00000000000000000001"/);
  assert.match(h, /In the service area/);
  // a lead: its priority as the pill, Priority in the "..."
  const ld = { ...s, contact: { ...contact, lifecycle: "lead", priority: "medium" } };
  assert.match(text(c.render(ld, ctx())), /class="pill fill-orange">Medium</);
  assert.ok(c.more(ld, ctx()).flat().filter(Boolean).some((r) => r.label === "Priority" && r.hint === "Medium"));
  // a tech: no stats, no Activity, numbers only
  const t = text(c.render({ contact: { id: contact.id, display_name: "Pat Example", phones: contact.phones, first_name: "Pat" }, properties: [property], users: [], tech: true }, ctx(["contacts:read"])));
  assert.doesNotMatch(t, /role="tablist"|data-notes|Activity/);
  assert.match(t, /href="tel:\+17635550100"/);
  assert.deepEqual(c.more({ tech: true }, ctx(["contacts:read"])), []);
});

test("New lead / edit, Quick lead, Property, Merge review and Lead webhooks render", async () => {
  const edit = await load("edit");
  const e = text(edit.render({ isNew: true, c: { phones: [], emails: [], tags: [], source: { source: "Phone Call" }, lifecycle: "lead" }, clientId: "x" }, ctx()));
  assert.match(e, /OK to text them about their quote and visits/);
  assert.match(e, /name="phone_0"[^>]*type="tel"|type="tel"[^>]*name="phone_0"/);
  assert.match(e, /inputmode="tel"/);
  const e2 = text(edit.render({ isNew: false, c: contact, etag: '"1"' }, ctx()));
  assert.match(e2, /value="\(763\) 555-0100"/);
  assert.ok(!e2.includes("<script>alert(1)"));

  const quick = await load("quick");
  assert.match(text(quick.render({ clientId: "x" }, ctx(["leads:create"]))), /Send to the office/);

  const prop = await load("property");
  const p = text(prop.render({ p: property, contact: { id: contact.id, name: "Pat Example" }, etag: '"1"' }, ctx()));
  assert.match(p, /Gate code/);
  assert.match(p, /3.2 mi from Delano/);
  assert.match(p, /Directions/);

  const merge = await load("merge");
  const a = { id: "ct_1", n: "Jordan Sample", lc: "lead", p: ["7635550180"], e: [], a: "1 Elm, Delano", z: "55328", src: "Website", tg: [] };
  const b = { id: "ct_2", n: "Jordan Sample", lc: "customer", p: ["7635550181"], e: [], a: "1 Elm, Delano", z: "55328", src: "Website", tg: [] };
  const m = text(merge.render({ rows: [{ id: "mc_1", reason: "name_zip", confidence: "medium", a, b }], counts: { medium: 1 }, total: 1 }, ctx()));
  assert.match(m, /Same name and ZIP/);
  assert.match(m, /class="diff"/, "the differing phone is highlighted");
  assert.match(m, /Keep the first/);
  assert.match(m, /Not the same person/);

  const hooks = await load("hooks");
  assert.match(text(hooks.render({ list: [{ id: "abc123", label: "Zapier", source: "Meta Ads", created_at: NOW }] }, ctx())), /Revoke/);
});

test("the client manifest: routes with parents, the create button, settings", async () => {
  const m = (await import("../../../crm-app/modules/contacts/manifest.js")).default;
  for (const r of m.routes) {
    assert.ok(r.perm, `${r.path} has a permission`);
    if (r.path !== "/contacts") assert.ok(r.parent, `${r.path} names its parent`);
  }
  assert.ok(m.creates.some((c) => c.path === "/leads/new"));
  assert.ok(m.settings.some((s) => s.path === "/settings/lead-hooks" && s.perm === "settings:owner"));
});
