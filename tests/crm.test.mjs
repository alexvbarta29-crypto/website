// /crm — Barta Office → Customers: the Rotor export the office imported,
// read from the "crm" Blobs store (a Map here). Fixture people are made up
// (555 numbers, example.com).
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, failingStore, hangingStore } from "./helpers/referral-harness.mjs";

process.env.OFFICE_PASSWORD = "test-password";
const { seal, open, newKeyPair, privateKey } = await import("../netlify/lib/office-data.mjs");
const data = await import("../netlify/lib/crm-data.mjs");
const { loadCustomers, customersSorted, displayName, sortName, initial, phoneDigits, phoneFormatted, addressLines, mapsUrl, memberName, memberNames, assignedNames, sinceLabel, sourceCounts, customerView, ROTOR_CUSTOMER_URL, LIMITS } = data;
const { customersHtml, importHtml, setupHtml, importedLabel, IMPORT_PATH, SOURCE_CHIPS } = await import("../netlify/lib/crm-page.mjs");
const { buildCustomerIndex, writeCustomerIndex, readCustomerIndex, indexSummary, KEYS, TIMEOUT_MS, memberSummary } = await import("../netlify/lib/crm-store.mjs");
const { buildBundle, fixMojibake, sealClean, BundleError } = await import("../build/crm_seal_import.mjs");
const { MAX_PAGE_BYTES } = await import("../netlify/functions/crm-import.mjs");
const crm = (await import("../netlify/functions/crm.mjs")).default;
const { derive } = await import("../netlify/lib/lights-auth.mjs");
const { TOOLS } = await import("../netlify/lib/office-page.mjs");
const signedIn = { cookie: "barta_office=" + derive("test-password") };
const keys = newKeyPair();

const addr = (street1, city, state, zip, street2 = null) => ({ street1, street2, city, state, zip, country: "US" });
const FIX = {
  v: 1,
  exported_at: "2026-11-08",
  members: [{ user_id: "m1", name: "Alex Barta", email: "alex@example.com", role: "owner" }, { user_id: "m2", name: "Jacob Barta", email: "jacob@example.com", role: "owner" }],
  customers: [
    { id: "c-1", first_name: "Pat", last_name: "Zimmer", company_name: "", email: "pat@example.com", phone: "+15550100123", status: "active", source: "Referral", assigned_to: ["m1"], address: addr("100 Example Ave", "Delano", "MN", "55328"), tags: ["Christmas Lights", "Website"], notes: "Gate code 4321\nDog in the yard", created_at: "2025-03-14T15:00:00+00:00" },
    { id: "c-2", first_name: "Sam", last_name: "Ames", company_name: "Ames Dental", email: "", phone: "", status: "inactive", source: "Website quote form", assigned_to: [], address: { street1: null, street2: null, city: null, state: null, zip: null, country: "United States" }, tags: [], notes: "", created_at: "2026-07-29T19:12:48+00:00" },
    { id: "c-3", first_name: "Chris", last_name: "", company_name: "Delano Hardware", email: "shop@example.com", phone: "5550100199", status: "active", source: "Returning Customer", assigned_to: ["m1", "m2"], address: addr("12 Main St", "Maple Plain", "MN", "55359", "Suite 2"), tags: ["Yard Sign"], notes: "", created_at: "2026-07-29T19:12:48+00:00" },
    { id: "c-4", first_name: "Sue", last_name: "& Dan Baker", company_name: null, email: null, phone: "+155501001777", status: "active", source: "Returning Customer", assigned_to: ["m2"], address: addr("77 Lake Rd", "Mound", "MN", "55364"), tags: [], notes: null, created_at: "2026-07-29T19:12:48+00:00" },
    { id: "c-5", first_name: "Ana", last_name: "Ávila", company_name: "", email: "", phone: "+15550100155", status: "active", source: "Facebook", assigned_to: [], address: addr("9 Birch Ln", "Waconia", "MN", "55387"), tags: [], notes: "", created_at: "2026-09-02T12:00:00+00:00" },
  ],
};
// 3:30 in the afternoon in Minnesota, so the "Imported" date is Nov 8 there too.
const NOW = new Date("2026-11-08T21:30:00Z");

let store;
beforeEach(() => { store = createMemoryStore(); globalThis.__crmStoreOverride = store; });
const imported = (bundle = FIX, now = NOW) => writeCustomerIndex(buildCustomerIndex(bundle, { now }));
const quietly = async (fn) => { const m = mock.method(console, "error", () => {}); try { return await fn(); } finally { m.mock.restore(); } };

test("an import is one write of the index the page reads; a re-import replaces it and leaves nothing behind", async () => {
  const sum = await imported();
  assert.deepEqual(store.keys(), [KEYS.customers], "one blob: no per-customer copies, no separate meta record");
  const idx = store.json(KEYS.customers);
  assert.equal(idx.v, 1);
  assert.equal(idx.imported_at, "2026-11-08T21:30:00.000Z");
  assert.equal(idx.exported_at, "2026-11-08");
  assert.equal(idx.count, 5);
  assert.deepEqual(idx.customers, FIX.customers);
  assert.deepEqual(idx.members, [{ user_id: "m1", name: "Alex Barta" }, { user_id: "m2", name: "Jacob Barta" }], "names only: no emails or roles in the index");
  assert.doesNotMatch(JSON.stringify(idx.members), /@|role/);
  assert.deepEqual(sum, { imported_at: "2026-11-08T21:30:00.000Z", exported_at: "2026-11-08", counts: { customers: 5, members: 2 } });
  assert.deepEqual(indexSummary(idx), sum, "the summary comes from the index itself");
  assert.equal(indexSummary(null), null);
  assert.deepEqual(await readCustomerIndex(), idx);
  // A smaller re-import replaces the list, and the dropped customers are gone from the store.
  await imported({ ...FIX, customers: FIX.customers.slice(0, 2), exported_at: "2026-11-09" }, () => new Date("2026-11-09T18:00:00Z"));
  assert.deepEqual(store.keys(), [KEYS.customers]);
  assert.equal(store.json(KEYS.customers).count, 2);
  assert.equal(store.json(KEYS.customers).imported_at, "2026-11-09T18:00:00.000Z");
  const raw = [...store.map.values()].join("\n");
  for (const gone of FIX.customers.slice(2)) assert.ok(!raw.includes(gone.id), "no trace of a customer the newer export dropped");
  assert.doesNotMatch(raw, /shop@example|Delano Hardware|Waconia/);
  // Members without a display name get first + last; rows without an id are skipped.
  assert.deepEqual(memberSummary({ user_id: "m9", first_name: "Dana", last_name: "Lee", email: "d@example.com" }), { user_id: "m9", name: "Dana Lee" });
  const odd = buildCustomerIndex({ exported_at: "2026-11-08", customers: [{ id: "c-7" }, { first_name: "no id" }, null, [1]], members: [{ name: "ghost" }] }, { now: NOW });
  assert.deepEqual(odd.customers, [{ id: "c-7" }]);
  assert.equal(odd.count, 1);
  assert.deepEqual(odd.members, []);
});

test("loadCustomers: nothing before the first import, a store error when Blobs fails or hangs, the index after", async () => {
  assert.deepEqual(await loadCustomers(), { ok: false, reason: "no-data" });
  await imported();
  const got = await loadCustomers();
  assert.equal(got.ok, true);
  assert.equal(got.data.customers.length, 5);
  assert.equal(got.data.imported_at, "2026-11-08T21:30:00.000Z");
  // A blob that isn't a customer index is treated as missing, never thrown.
  await store.setJSON(KEYS.customers, { hello: "world" });
  assert.deepEqual(await loadCustomers(), { ok: false, reason: "no-data" });
  // A blob that isn't JSON at all is "bad-index" (the page offers Import), not a storage outage.
  await store.set(KEYS.customers, "{truncated");
  assert.deepEqual(await quietly(loadCustomers), { ok: false, reason: "bad-index" });
  // Rows that aren't objects never reach the page.
  await store.setJSON(KEYS.customers, { v: 1, count: 3, members: [], customers: [null, FIX.customers[0], [1, 2], "x"] });
  assert.deepEqual((await loadCustomers()).data.customers, [FIX.customers[0]]);
  globalThis.__crmStoreOverride = failingStore();
  assert.deepEqual(await quietly(loadCustomers), { ok: false, reason: "store" });
  // Blobs hanging: every call has a timeout, so the page still gets an answer.
  globalThis.__crmStoreOverride = hangingStore();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = quietly(loadCustomers);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(TIMEOUT_MS);
    assert.deepEqual(await pending, { ok: false, reason: "store" });
  } finally {
    mock.timers.reset();
  }
  assert.equal(TIMEOUT_MS, 8000);
});

test("names, phones and addresses read the way the office writes them", () => {
  const [pat, sam, chris, sue, ana] = FIX.customers;
  assert.equal(displayName(pat), "Pat Zimmer");
  assert.equal(displayName(chris), "Chris");
  assert.equal(displayName({ first_name: "", last_name: "", company_name: "Shop" }), "Shop");
  assert.equal(displayName({}), "No name");
  assert.equal(displayName({ first_name: "robin", last_name: "quill" }), "Robin Quill", "all-lower-case names get their capitals back");
  assert.equal(displayName({ first_name: "(Delano Little League)", last_name: "" }), "(Delano Little League)", "anything with a capital is left alone");
  assert.equal(displayName({ first_name: "Sue", last_name: "and Dana Baker Smith" }), "Sue and Dana Baker Smith");
  assert.equal(phoneDigits("+15550100123"), "5550100123");
  assert.equal(phoneFormatted("+15550100123"), "(555) 010-0123");
  assert.equal(phoneFormatted("5550100199"), "(555) 010-0199");
  assert.equal(phoneFormatted("+155501001777"), "+155501001777", "a number that isn't 10 digits is left alone");
  assert.equal(phoneFormatted(""), "");
  assert.deepEqual(addressLines(pat), ["100 Example Ave", "Delano, MN 55328"]);
  assert.deepEqual(addressLines(chris), ["12 Main St, Suite 2", "Maple Plain, MN 55359"]);
  assert.deepEqual(addressLines(sam), []);
  assert.deepEqual(addressLines({ address: "1 Elm St, Delano, MN" }), ["1 Elm St", "Delano", "MN"]);
  assert.equal(mapsUrl(pat), "https://maps.apple.com/?q=100%20Example%20Ave%2C%20Delano%2C%20MN%2055328");
  assert.equal(mapsUrl(sam), "");
  assert.equal(memberName("m2", FIX.members), "Jacob Barta");
  assert.equal(memberName("m2", [{ user_id: "m2", name: "Jacob Barta" }]), "Jacob Barta", "the index carries names only");
  assert.equal(memberName("nobody", FIX.members), "");
  assert.deepEqual(assignedNames(chris, FIX.members), ["Alex Barta", "Jacob Barta"]);
  // The page looks members up in a Map built once, not a search per row.
  const names = memberNames(FIX.members);
  assert.ok(names instanceof Map);
  assert.equal(memberNames(names), names);
  assert.deepEqual(assignedNames(chris, names), ["Alex Barta", "Jacob Barta"]);
  assert.equal(memberName("m1", names), "Alex Barta");
  assert.deepEqual([...memberNames([{ user_id: "m1", name: "First" }, { user_id: "m1", name: "Second" }, null, { name: "no id" }])], [["m1", "First"]], "the first entry for an id wins, as before");
  assert.equal(sinceLabel("2025-03-14T15:00:00+00:00"), "Mar 2025");
  assert.equal(sinceLabel("junk"), "");
  assert.equal(importedLabel("2026-11-08T21:30:00.000Z"), "Nov 8, 2026");
  assert.equal(importedLabel("2026-11-09T04:30:00.000Z"), "Nov 8, 2026", "company time, not UTC");
  assert.equal(importedLabel(""), "");
  // Sorting: by last name, then first name, then company; odd names still land under a letter.
  assert.deepEqual(customersSorted(FIX.customers).map((c) => c.id), ["c-2", "c-5", "c-3", "c-4", "c-1"]);
  assert.equal(sortName(sue), "Dan Baker");
  assert.equal(initial(sue), "D");
  assert.equal(initial(ana), "A");
  assert.equal(initial(chris), "C", "no last name: the first name decides");
  assert.equal(initial({ first_name: "", last_name: "", company_name: "7-Eleven" }), "#");
  assert.deepEqual(sourceCounts(FIX.customers).slice(0, 2), [{ label: "Returning Customer", count: 2 }, { label: "Facebook", count: 1 }]);
  const v = customerView(pat, FIX.members);
  assert.equal(v.company, "");
  assert.deepEqual(v.tags, ["Christmas Lights", "Website"]);
  assert.deepEqual(v.assigned, ["Alex Barta"]);
  assert.equal(v.statusLabel, "Active");
  assert.equal(customerView(chris, FIX.members).company, "Delano Hardware");
});

test("the Customers page lists everyone with phones, towns, chips and letters", () => {
  const html = customersHtml({ ...FIX, imported_at: NOW.toISOString() });
  assert.match(html, /Pat Zimmer/);
  assert.match(html, /Delano Hardware/);
  assert.match(html, /\(555\) 010-0123/);
  assert.match(html, /class="town">Delano</);
  assert.match(html, /maps\.apple\.com\/\?q=100%20Example%20Ave%2C%20Delano%2C%20MN%2055328/);
  assert.match(html, /"tags":\["Christmas Lights","Website"\]/);
  assert.match(html, /"assigned":\["Alex Barta","Jacob Barta"\]/);
  assert.match(html, /"since":"Mar 2025"/);
  assert.match(html, /<b>5<\/b> customers · from Rotor, Nov 8, 2026/);
  assert.match(html, /data-status="active" aria-pressed="false">Active <b>4<\/b>/);
  assert.match(html, /data-status="inactive" aria-pressed="false">Inactive <b>1<\/b>/);
  assert.match(html, /data-src="Returning Customer" aria-pressed="false">Returning Customer <b>2<\/b>/);
  for (const l of ["A", "C", "D", "Z"]) assert.match(html, new RegExp(`<section class="grp" data-l="${l}">`));
  assert.match(html, /placeholder="Search name, phone, address…"/);
  assert.match(html, /No one matches/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /safe-area-inset/);
  assert.match(html, /pushState/);
  assert.match(html, /Escape/);
  assert.match(html, new RegExp(ROTOR_CUSTOMER_URL.replace(/[./]/g, "\\$&")));
  assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"|https?:\/\/fonts\./, "no external scripts or fonts");
  // The quiet re-import link under the list.
  assert.equal(IMPORT_PATH, "/crm?import=1");
  assert.match(html, /<p class="foot">Imported Nov 8, 2026 · <a href="\/crm\?import=1">Re-import<\/a><\/p>/);
  assert.doesNotMatch(customersHtml(FIX), /class="foot"/, "no footer when the import date is unknown");
  // Member ids and emails never reach the browser.
  assert.doesNotMatch(html, /"m1"|"m2"|user_id|alex@|jacob@/);
  assert.equal(SOURCE_CHIPS, 6);
  // An empty export still renders a page.
  assert.match(customersHtml({ customers: [], members: [] }), /<b>0<\/b> customers/);
});

test("a hostile name or note never breaks out of the page", () => {
  const evil = { ...FIX, customers: [
    { ...FIX.customers[0], id: "e-1", first_name: "Bob</script><script>alert(1)", last_name: "Hacker", notes: '<img src=x onerror=alert(1)>', company_name: '"><b>x', tags: ["</script>"], address: addr('1 "Quote" St', "Delano", "MN", "55328") },
  ] };
  const html = customersHtml(evil);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /Bob&lt;\/script&gt;&lt;script&gt;alert\(1\)/, "escaped in the list");
  assert.match(html, /\\u003c\/script>\\u003cscript>alert\(1\)/, "escaped in the JSON");
  assert.match(html, /\\u003cimg src=x onerror/);
  assert.match(html, /&quot;&gt;&lt;b&gt;x/);
});

test("signed out, /crm sends you to the office's Customers tab and shows no one", async () => {
  await imported();
  const res = await crm(new Request("https://x.test/crm"));
  const body = await res.text();
  assert.match(body, /\/office#customers/);
  assert.doesNotMatch(body, /Pat Zimmer|class="row"|Import your customers/);
  assert.doesNotMatch(await (await crm(new Request("https://x.test/crm?import=1"))).text(), /Import your customers/);
});

test("signed in before the first import, /crm is the Import screen", async () => {
  const res = await crm(new Request("https://x.test/crm", { headers: signedIn }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  const html = await res.text();
  assert.match(html, /<h1>Import your customers<\/h1>/);
  assert.match(html, /Upload the sealed export file Claude gave you\. It only opens on this site\./);
  assert.match(html, /<label class="btn file" for="file">Choose file<input type="file" id="file" name="file" accept="\.json,application\/json"/);
  assert.match(html, /<button type="submit" class="btn go" id="go" disabled>Import<\/button>/);
  assert.match(html, /id="status" role="status"/);
  assert.match(html, /new FileReader\(\)/);
  assert.match(html, /readAsText/);
  assert.match(html, /fetch\('\/api\/crm\/import' \+ \(confirmed \? '\?confirm=1' : ''\), \{ method: 'POST', credentials: 'same-origin', headers: \{ 'Content-Type': 'application\/json' \}/);
  assert.match(html, /<button type="button" class="btn go" id="force" hidden>Replace anyway<\/button>/, "a bigger or newer list is only replaced after a second tap");
  assert.match(html, /code === 'confirm'/);
  assert.match(html, /location\.replace\('\/crm'\)/, "reloads the list on success");
  assert.match(html, /\/office#customers/, "a 401 sends the whole window to the office sign-in");
  for (const text of ["The site has no OFFICE_DATA_KEY yet", "That file was sealed for a different key", "That is not a Barta export file", "That export has no customers in it", "5,000 at most", "not on a preview"]) assert.match(html, new RegExp(text));
  assert.doesNotMatch(html, /couldn&#39;t be read/, "no damaged-list notice when nothing is wrong");
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /class="row"|Pat Zimmer|Back to the list|Last import/);
  assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"|https?:\/\/fonts\./, "no external scripts or fonts");
  assert.equal(store.keys().length, 0, "showing the screen writes nothing");
  // The same screen from the module, for the markup's sake.
  assert.equal(importHtml(), html);
});

test("signed in after an import, /crm renders the customers (GET and HEAD; POST is refused) and offers a re-import", async () => {
  await imported();
  const res = await crm(new Request("https://x.test/crm", { headers: signedIn }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = await res.text();
  assert.match(body, /Pat Zimmer/);
  assert.match(body, /\(555\) 010-0199/);
  assert.match(body, /"tags":\["Yard Sign"\]/);
  assert.match(body, /<b>5<\/b> customers · from Rotor, Nov 8, 2026/);
  assert.match(body, /Imported Nov 8, 2026 · <a href="\/crm\?import=1">Re-import<\/a>/);
  assert.doesNotMatch(body, /Import your customers/);
  assert.doesNotMatch(body, /alex@|jacob@|"m1"/, "member emails and ids stay on the server");
  const head = await crm(new Request("https://x.test/crm", { method: "HEAD", headers: signedIn }));
  assert.equal(head.status, 200);
  const post = await crm(new Request("https://x.test/crm", { method: "POST", headers: signedIn, body: "x" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  // Re-import: the Import screen again, saying what it will replace, with a way back.
  const again = await crm(new Request("https://x.test/crm?import=1", { headers: signedIn }));
  assert.equal(again.status, 200);
  const screen = await again.text();
  assert.match(screen, /<h1>Import your customers<\/h1>/);
  assert.match(screen, /Last import: Nov 8, 2026 · 5 customers\. A re-import replaces everything\./);
  assert.match(screen, /<a class="back-link" href="\/crm">&larr; Back to the list<\/a>/);
  assert.doesNotMatch(screen, /Pat Zimmer|class="row"/, "no customer data on the import screen");
  // Still private even with data: no cookie, no list.
  assert.doesNotMatch(await (await crm(new Request("https://x.test/crm/"))).text(), /Pat Zimmer/);
});

test("when storage doesn't answer, the page says so instead of crashing, and Import stays reachable", async () => {
  globalThis.__crmStoreOverride = failingStore();
  const res = await quietly(() => crm(new Request("https://x.test/crm", { headers: signedIn })));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const html = await res.text();
  assert.match(html, /<h1>Storage didn&#39;t answer<\/h1>|<h1>Storage didn't answer<\/h1>/);
  assert.doesNotMatch(html, /Import your customers|class="row"/);
  assert.match(html, /<a class="back-link" href="\/crm\?import=1">Re-import<\/a>/, "a way back to Import");
  assert.match(setupHtml("whatever"), /Storage didn/);
  // ?import=1 is the Import screen even while the list can't be read.
  const imp = await quietly(() => crm(new Request("https://x.test/crm?import=1", { headers: signedIn })));
  assert.equal(imp.status, 200);
  assert.match(await imp.text(), /<h1>Import your customers<\/h1>/);
});

test("a saved list that isn't readable shows the Import screen (so it can be imported over), and a null row can't crash the page", async () => {
  await store.set(KEYS.customers, "{truncated");
  for (const url of ["https://x.test/crm", "https://x.test/crm?import=1"]) {
    const res = await quietly(() => crm(new Request(url, { headers: signedIn })));
    assert.equal(res.status, 200, url);
    const html = await res.text();
    assert.match(html, /<h1>Import your customers<\/h1>/);
    assert.match(html, /The saved customer list couldn&#39;t be read\. Import the file again to replace it\./);
  }
  await store.setJSON(KEYS.customers, { v: 1, imported_at: NOW.toISOString(), exported_at: "2026-11-08", count: 2, members: [null], customers: [null, FIX.customers[0]] });
  const res = await crm(new Request("https://x.test/crm", { headers: signedIn }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Pat Zimmer/);
});

test("a list at the import cap still renders under the page budget", () => {
  const word = (i, n) => "Abcdefghij".slice(0, 3 + (i % 7)) + n;
  const customers = Array.from({ length: LIMITS.customers }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    first_name: word(i, "a"), last_name: word(i + 3, "b"), company_name: i % 5 ? null : "Example Window Co " + i,
    email: `person${i}@example.com`, phone: "+1555010" + String(i % 10000).padStart(4, "0"), status: i % 4 ? "active" : "inactive",
    source: ["Referral", "Website quote form", "Facebook", "Returning Customer"][i % 4], assigned_to: ["m1"],
    address: addr(`${100 + i} Example Ave`, "Delano", "MN", "55328"), tags: i % 3 ? [] : ["Christmas Lights", "Yard Sign"],
    notes: "Gate code 1234. Dog in the yard, ring the bell twice. ".repeat(i % 4), created_at: "2025-03-14T15:00:00+00:00",
  }));
  const html = customersHtml(buildCustomerIndex({ ...FIX, customers }, { now: NOW }));
  const bytes = Buffer.byteLength(html);
  assert.match(html, /<b>5,?000<\/b> customers/);
  assert.ok(bytes < MAX_PAGE_BYTES, `${(bytes / 1048576).toFixed(2)} MB`);
  assert.ok(MAX_PAGE_BYTES < 6 * 1024 * 1024, "the budget sits under Netlify's 6 MB response limit");
});

test("the seal script keeps the fields the site uses, fixes double-encoded names and seals cleanly", () => {
  assert.equal(fixMojibake("Oâ\u0080\u0099Connor"), "O’Connor");
  assert.equal(fixMojibake("Ávila"), "Ávila", "real accents are left alone");
  assert.equal(fixMojibake("O’Connor"), "O’Connor");
  // Rotor's ids are UUIDs; the made-up rows get UUID-shaped ones here.
  const uuid = (c) => ({ ...c, id: "00000000-0000-4000-8000-00000000000" + c.id.slice(-1) });
  const customers = FIX.customers.map(uuid);
  const rows = [{ ...customers[0], internal_score: 7, tags: ["Christmas Lights", "Website"] }, ...customers.slice(1), { ...customers[0] }, { id: "", first_name: "no id" }];
  const bundle = buildBundle(rows, FIX.members, "2026-11-08");
  assert.equal(bundle.v, 1);
  assert.equal(bundle.exported_at, "2026-11-08");
  assert.equal(bundle.customers.length, 5, "duplicates and rows without an id are dropped");
  assert.deepEqual(bundle.customers, customers, "the 13 fields the page uses are kept as exported");
  assert.equal("internal_score" in bundle.customers[0], false, "fields the site doesn't use are dropped");
  assert.deepEqual(bundle.members, [{ user_id: "m1", name: "Alex Barta" }, { user_id: "m2", name: "Jacob Barta" }], "member emails and roles never go into the file");
  assert.throws(() => buildBundle(rows, [], "yesterday"), /YYYY-MM-DD/);
  // A row the site would refuse stops the script, naming the place, never the value.
  assert.throws(() => buildBundle([{ ...customers[0], notes: "x".repeat(LIMITS.notes + 1) }], [], "2026-11-08"), (e) => e instanceof BundleError && e.field === "customers[0].notes" && !/xxx/.test(e.message));
  assert.throws(() => buildBundle([FIX.customers[0]], [], "2026-11-08"), (e) => e instanceof BundleError && e.field === "customers[0].id");
  assert.throws(() => buildBundle([], [], "2026-11-08"), (e) => e instanceof BundleError && e.code === "empty");
  const box = sealClean(bundle, keys.publicKeyPem);
  const text = JSON.stringify(box);
  assert.equal(box.v, 2);
  assert.doesNotMatch(text, /@|\d{10}|Zimmer|first_name/, "nothing readable in the sealed file");
  assert.deepEqual(open(box, privateKey({ OFFICE_DATA_KEY: keys.privateKey })), bundle);
  assert.throws(() => open(box, privateKey({ OFFICE_DATA_KEY: newKeyPair().privateKey })), "another key doesn't open it");
  assert.deepEqual(open(seal(bundle, keys.publicKeyPem), privateKey({ OFFICE_DATA_KEY: keys.privateKey })), bundle);
});

test("Customers is the first tool tab after the dashboards", () => {
  assert.equal(TOOLS[0].id, "dashboard");
  assert.deepEqual(TOOLS[1], { id: "customers", label: "Customers", src: "/crm" });
});
