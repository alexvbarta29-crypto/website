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
  const cmd = (await import("../../../crm-app/modules/import/list.js")).UPLOAD_COMMAND;
  assert.match(cmd, /^node build\/crm_import_upload\.mjs \S+ --site https:\/\/www\.bartawindowwashing\.com$/);
  assert.doesNotMatch(cmd, /bimp_|CRM_UPLOAD_KEY/, "the key never goes on a command line");
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

test("the rest of an export: what can come in now, what waits and for which part, the button; a continuation's own screen", async () => {
  const list = await load("list");
  const run = await load("run");
  const done = { id: RUN.id, status: "done", as_of: "2026-11-10", created_at: NOW, finished_at: NOW, summary: { created: 1265, updated: 3, conflicts: 0 } };
  const ready = [{ phase: "money.invoices", label: "Invoices", module: "money", module_label: "Money", entity: "invoices", rows: 712 }, { phase: "money.payments", label: "Payments", module: "money", module_label: "Money", entity: "payments", rows: 688 }];
  const waiting = [{ phase: "comms.messages", label: "Messages", module: "comms", module_label: "Messages", entity: "messages", rows: 10927, waiting_for: "comms" }];
  const rest = { run: { id: RUN.id, as_of: "2026-11-10" }, ready, waiting, staging: "ok", keep_until: "2026-12-17T15:00:00.000Z", active: null, auto: true };
  const html = text(list.render({ runs: [done], rest }, ctx));
  assert.match(html, /The rest of this export/);
  assert.match(html, /<dt>Money<\/dt><dd>1,400 rows<span class="im-steps">invoices, payments<\/span>/, "per part, each file's rows once");
  assert.match(html, /<button type="button" class="btn primary" data-continue>Bring in the rest now<\/button>/);
  assert.match(html, /by itself within the hour\. No upload, no key\./);
  assert.match(html, /<dt>Messages<\/dt><dd>10,927 rows/);
  assert.match(html, /until \w{3}, Dec 17/, "how long the rows are kept");
  // off: the screen says so and still offers the button
  const off = text(list.render({ runs: [done], rest: { ...rest, auto: false } }, ctx));
  assert.match(off, /by itself is off \(Settings, Data\)/);
  assert.match(off, /data-continue/);
  // the rows were cleared: no button, a plain way on
  const gone = text(list.render({ runs: [done], rest: { ...rest, staging: "cleared", keep_until: null } }, ctx));
  assert.match(gone, /rows were cleared[^<]*Start a new import/);
  assert.doesNotMatch(gone, /data-continue|Ready to bring in/);
  assert.match(gone, /Not brought in<\/div>[\s\S]*<dt>Money<\/dt>[\s\S]*<dt>Messages<\/dt>/, "what never came in, whatever is live now");
  // a newer import was started since and didn't finish: this export is the older one; no button
  const newer = text(list.render({ runs: [done], rest: { ...rest, blocked: "newer" } }, ctx));
  assert.match(newer, /A newer import was started after this one/);
  assert.doesNotMatch(newer, /data-continue|Ready to bring in/);
  // an import is running: a link to it, no second button
  assert.doesNotMatch(text(list.render({ runs: [done], rest: { ...rest, active: "ir_00000000000000000009" } }, ctx)), /data-continue/);
  // nothing left (or no import yet): no card
  assert.doesNotMatch(text(list.render({ runs: [done], rest: { ...rest, ready: [], waiting: [] } }, ctx)), /The rest of this export/);
  assert.doesNotMatch(text(list.render({ runs: [], rest: { run: null, ready: [], waiting: [] } }, ctx)), /The rest of this export/);
  assert.doesNotMatch(text(list.render({ runs: [done], rest: null }, ctx)), /The rest of this export/);
  // a continuation in the list, and its screen: what it continues, only its own steps, the chain's totals
  const cont = { id: "ir_00000000000000000002", status: "done", as_of: "2026-11-10", created_at: NOW, finished_at: NOW, continues: RUN.id, summary: { created: 1400, updated: 0, conflicts: 0 } };
  assert.match(text(list.render({ runs: [cont, done], rest: null }, ctx)), /More of this export · 1,400 added/);
  const phases = [
    { name: "contacts.customers", label: "Customers", status: "done", earlier: RUN.id, read: 0 },
    { name: "money.invoices", label: "Invoices", status: "done", read: 712, created: 712, updated: 0, unchanged: 0, linked: 0, conflicted: 0, skipped: 0 },
    { name: "comms.messages", label: "Messages", status: "waiting", waiting_label: "Messages", read: 0 },
  ];
  const report = { summary: { created: 1400, updated: 0, unchanged: 0, linked: 0, conflicts_open: 0, skipped: 0 }, waiting: [{ label: "Messages", rows: 10927, module_label: "Messages", entity: "messages" }],
    continues: RUN.id, chain: { runs: [RUN.id, cont.id], totals: { read: 16000, created: 9100, updated: 12 } }, quality: { warnings: {} } };
  const scr = text(run.render({ run: { ...RUN, ...cont, auto: true, conflicts: { open: 0, resolved: 0 } }, upload: null, phases, lane: { status: "done" }, team: null, report, rest: { ...rest, run: { id: cont.id }, ready: [] } }, ctx));
  assert.match(scr, /Started by itself when a part of the CRM went live/);
  assert.match(scr, /<h2>More of the export of Nov 10, 2026<\/h2>/);
  assert.match(scr, /href="#\/import\/ir_00000000000000000001">The import it continues/);
  assert.match(scr, /1 step was done by the import this one continues/);
  assert.doesNotMatch(scr, /<span class="nm">Customers<\/span>/, "steps done earlier aren't listed as this run's");
  assert.match(scr, /<span class="nm">Invoices<\/span>/);
  assert.match(scr, /9,100 added and 12 updated from 16,000 rows/);
  assert.match(scr, /Waiting for a part that isn&#39;t live yet|Waiting for a part that isn't live yet/);
  assert.doesNotMatch(scr, /Upload<\/h2>|data-member|data-continue/, "no upload, no team map, nothing ready");
  // a continuation that stopped for good: Resume (and Cancel); when its rows were cleared, no Resume
  const failed = { ...RUN, ...cont, status: "failed", finished_at: NOW, stopped: { code: "blobstransienterror" }, conflicts: { open: 0, resolved: 0 } };
  const stoppedScr = text(run.render({ run: failed, upload: null, phases, lane: { status: "failed" }, team: null, report: null, rest: null }, ctx));
  assert.match(stoppedScr, /<span class="pill red">Stopped<\/span>/);
  assert.match(stoppedScr, /data-resume/);
  assert.match(stoppedScr, /data-cancel/);
  const goneScr = text(run.render({ run: { ...failed, stopped: { code: "staging_gone" } }, upload: null, phases, lane: { status: "failed" }, team: null, report: null, rest: null }, ctx));
  assert.match(goneScr, /rows were cleared before it could finish/);
  assert.doesNotMatch(goneScr, /data-resume/);
  // an older import keeps its own report's list of what waited
  const old = text(run.render({ run: { ...RUN, status: "done", finished_at: NOW }, upload: { chunks: 5, expected: 5, missing: [], missing_count: 0 }, phases: [], lane: null, team: null, report: { ...report, chain: null, continues: null }, rest: null }, ctx));
  assert.match(old, /Waiting for a later part of the CRM/);
  assert.equal(kit.byPart([{ label: "A", module: "m", entity: "x", rows: 0 }]).length, 0, "nothing waits where the export has no rows");
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
