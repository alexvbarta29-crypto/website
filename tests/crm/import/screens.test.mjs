// The Import screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation lands where html`` allows it, values
// are escaped, downloads stay on the site, and each screen says what it
// should. The phone walk (Playwright) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/import/${name}.js`)).default;
const manifest = (await import("../../../crm-app/modules/import/manifest.js")).default;
const kit = await import("../../../crm-app/modules/import/kit.js");
const ctx = { can: () => true, user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, params: {} };
const text = (safe) => String(safe);
const NOW = "2026-11-17T15:00:00.000Z";
const RUN = { id: "ir_00000000000000000001", status: "uploading", as_of: "2026-11-10", note: "weekly", created_at: NOW, upload: { last4: "abcd", expires_at: "2026-11-18T15:00:00.000Z", expired: false }, manifest: { as_of: "2026-11-10" }, conflicts: { open: 0, resolved: 0 } };

test("the manifest: owners only, under More and Settings", () => {
  assert.deepEqual(manifest.routes.map((r) => [r.path, r.perm]), [["/import", "import:run"], ["/import/:id", "import:run"], ["/import/:id/conflicts", "import:run"]]);
  assert.equal(manifest.nav[0].perm, "import:run");
  assert.equal(manifest.settings[0].owner, true);
});

test("the list: runs with their state, and Start when none runs", async () => {
  const list = await load("list");
  const html = text(list.render({ runs: [{ id: RUN.id, status: "done", as_of: "2026-11-10", created_at: NOW, summary: { created: 1265, updated: 3, conflicts: 2 } }] }, ctx));
  assert.match(html, /Export of Nov 10, 2026/);
  assert.match(html, /1,265 added/);
  assert.match(html, /Done · 2 to settle/);
  assert.match(html, /data-start/);
  const running = text(list.render({ runs: [{ id: RUN.id, status: "running", created_at: NOW }] }, ctx));
  assert.doesNotMatch(running, /data-start/, "one import at a time");
  assert.match(running, /See the import that&#39;s running|See the import that's running/);
  assert.match((await import("../../../crm-app/modules/import/list.js")).UPLOAD_COMMAND("bimp_x"), /^CRM_UPLOAD_KEY=bimp_x node build\/crm_import_upload\.mjs .* --site https:\/\/www\.bartawindowwashing\.com$/);
});

test("a run: upload, team map, steps, the report with its downloads", async () => {
  const run = await load("run");
  const team = { members: [{ rid: "r1", name: "Avery <b>Sample</b>", role: "owner", match: { id: "us_00000000000000000001", how: "name", name: "Avery Sample" } }, { rid: "r2", name: "Drew Example", role: "member", match: null }], users: [{ id: "us_00000000000000000001", name: "Avery Sample", status: "active" }], done: false };
  const up = text(run.render({ run: RUN, upload: { chunks: 3, expected: 5, missing: ["messages-0001", "messages-0002"], missing_count: 2, media: 0, media_expected: 4 }, phases: [], lane: null, team }, ctx));
  assert.match(up, /3 of 5 received/);
  assert.match(up, /messages-0001/);
  assert.match(up, /Avery &lt;b&gt;Sample&lt;\/b&gt;/, "names are escaped");
  assert.match(up, /<button type="button" class="btn primary" data-start disabled>/, "Start waits for every chunk");
  assert.match(up, /data-member="r2"/);
  assert.match(up, /New user \(invited\)/);
  const phases = [
    { name: "contacts.customers", label: "Customers", status: "done", read: 780, created: 780, updated: 0, unchanged: 0, linked: 0, conflicted: 0, skipped: 0 },
    { name: "money.invoices", label: "Invoices", status: "waiting", waiting_label: "Money", read: 0 },
  ];
  const report = { summary: { created: 1560, updated: 0, unchanged: 0, linked: 5, conflicts_open: 0, skipped: 2 }, waiting: [{ label: "Invoices", rows: 712, module_label: "Money" }],
    money: { rotor: { invoices: { count: 712, total_cents: 2675679400 }, payments: { count: 688, net_cents: 2624915800, refunds_cents: 10000, tips_cents: 122500 } } }, quality: { warnings: { phone_twelve_digits: 2, address_state: 9 } } };
  const done = text(run.render({ run: { ...RUN, status: "done", finished_at: NOW }, upload: { chunks: 5, expected: 5, missing: [], missing_count: 0 }, phases, lane: { status: "done" }, team: { ...team, done: true }, report }, ctx));
  assert.match(done, /1,560/);
  assert.match(done, /<dt>Money<\/dt><dd>712 rows<span class="im-steps">invoices<\/span>/);
  assert.match(done, /\$26,756,794\.00/);
  assert.match(done, /Phones with 12 digits/);
  assert.match(done, /href="\/api\/crm\/import\/runs\/ir_00000000000000000001\/idmap\.csv" download/);
  assert.match(done, /built yet[^<]*Money/, "the steps say which parts wait");
  assert.match(done, /Nothing to settle/);
  const stopped = text(run.render({ run: { ...RUN, status: "running" }, upload: { chunks: 5, expected: 5, missing: [], missing_count: 0 }, phases, lane: { status: "failed" }, team: null }, ctx));
  assert.match(stopped, /data-resume/);
  assert.match(stopped, /Stopped/);
});

test("conflicts: the three values, escaped, and the two choices", async () => {
  const c = await load("conflicts");
  const html = text(c.render({ id: RUN.id, rows: [{ key: "ir_00000000000000000001--contact--ct_00000000000000000001--last_name", type: "contact", id: "ct_00000000000000000001", field: "last_name", label: "Pat <i>Example</i>", base: "Old", crm: "Human", rotor: "Rotor", status: "open" }], next: null, done: [] }, ctx));
  assert.match(html, /1 field to settle/);
  assert.match(html, /Pat &lt;i&gt;Example&lt;\/i&gt;/);
  assert.match(html, /Last name/);
  assert.match(html, /data-take="rotor"/);
  assert.match(html, /href="#\/contacts\/ct_00000000000000000001"/);
  assert.equal(kit.valueText({ street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }), "1 Example Ave, Delano, MN 55328");
  assert.equal(kit.valueText([{ e164: "+17635550101" }]), "+17635550101");
  assert.equal(kit.valueText(null), "—");
});
