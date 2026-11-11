// Comms: campaign audiences (design §5.7.5, B4; §11.4 M6 audience.test):
// the pure filter over contacts-index rows, the counts against a fixture
// query, and the preview over the full synthetic export at scale 1 inside
// one request's budget, from the index only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { generate } from "../fixtures/rotor-synthetic.mjs";
import { store, W, scope } from "./fixtures.mjs";

const { evaluateAudience, audienceChoices } = await import("../../../netlify/lib/crm/modules/comms/audience.mjs");
const { cleanAudience } = await import("../../../netlify/lib/crm/modules/comms/types.mjs");
const { contactRow } = await import("../../../netlify/lib/crm/modules/contacts/types.mjs");

const row = (n, o = {}) => ({ id: `ct_${String(n).padStart(20, "0")}`, n: `Pat ${n}`, p: [`763555${String(1000 + n).slice(-4)}`], e: [`pat${n}@example.com`], c: "Delano", z: "55328", lc: "customer", src: "Website quote form", tg: [], ...o });

test("the audience is a pure filter over index rows; what is always left out is counted by reason", () => {
  const rows = [
    row(1), row(2, { c: "Wayzata", z: "55391" }), row(3, { lc: "lead", tg: ["Giveaway 2026"] }), row(4, { lc: "archived" }), row(5, { fl: { test: true } }),
    row(6, { p: [] }), row(7, { p: ["7635551001"] }), row(8, { rv: "2026-10-01T00:00:00.000Z" }), row(9, { pl: ["pl_x"], svc_q: ["Gutter Cleaning"], oq: true }), row(10, { src: "Meta Ads" }),
  ];
  const sup = new Set(["k:7635551010"]);
  const ev = (a, o = {}) => evaluateAudience(rows, a, { channel: "sms", suppressed: sup, addressKey: (x) => `k:${x}`, ...o });
  assert.deepEqual(ev({}).ids, [], "an empty audience is nobody");
  const all = ev({ lifecycle: ["customer", "lead", "archived"] });
  assert.deepEqual(all.excluded, { archived: 1, excluded_flag: 1, no_address: 1, duplicate: 1, opted_out: 1 });
  assert.deepEqual(all.ids.map((x) => Number(x.slice(3))), [1, 2, 3, 8, 9]);
  assert.equal(all.matched, 10);
  assert.deepEqual(ev({ lifecycle: ["customer"], towns: ["wayzata"] }).ids.length, 1, "towns ignore case");
  assert.deepEqual(ev({ zips: ["55391"] }).count, 1);
  assert.deepEqual(ev({ tags_any: ["giveaway 2026"] }).ids.map((x) => Number(x.slice(3))), [3]);
  assert.equal(ev({ lifecycle: ["customer", "lead"], tags_none: ["Giveaway 2026"] }).ids.includes(rows[2].id), false);
  assert.deepEqual(ev({ sources: ["Meta Ads"] }).excluded, { opted_out: 1 });
  assert.equal(ev({ lifecycle: ["customer"], no_review: true }).ids.includes(rows[7].id), false, "no review yet");
  assert.deepEqual(ev({ plan_status: ["active"] }).ids.map((x) => Number(x.slice(3))), [9]);
  assert.deepEqual(ev({ services_quoted: ["gutter cleaning"], has_open_quote: true }).count, 1);
  assert.deepEqual(ev({ include_ids: [rows[0].id, rows[3].id] }).ids, [rows[0].id], "added by hand, the rules still apply");
  assert.equal(ev({ lifecycle: ["customer"], exclude_ids: [rows[0].id] }).excluded.excluded_by_hand, 1);
  assert.equal(ev({ lifecycle: ["customer"] }, { recent: new Set([rows[0].id]) }).excluded.recent_campaign, 1);
  assert.equal(evaluateAudience(rows, { lifecycle: ["customer"] }, { channel: "email" }).count, 7, "email: by address (the customer with no phone has one)");
  // a filter whose column no module has put in the list yet matches nobody and says so
  const un = ev({ lifecycle: ["customer"], services_done: ["Window Cleaning"], last_service_between: ["2026-09-01", "2026-10-31"] });
  assert.deepEqual([un.count, un.unsupported], [0, ["services_done", "last_service_between"]]);
  assert.equal(evaluateAudience([...rows, row(11, { svc_d: ["Window Cleaning"], ls: "2026-10-02" })], { services_done: ["window cleaning"], last_service_between: ["2026-09-01", "2026-10-31"] }, {}).count, 1, "once the column is there, it filters");
  assert.deepEqual(audienceChoices(rows).towns[0], { value: "Delano", n: 9 });
  assert.throws(() => cleanAudience({ lifecycle: "customer" }), /Too many|Expected|values/i);
  assert.throws(() => cleanAudience({ include_ids: ["nope"] }), /contact/);
  assert.deepEqual(cleanAudience({ towns: [" Delano ", "Delano", ""], no_review: true, junk: 1 }), { towns: ["Delano"], no_review: true });
});

test("the preview over the full synthetic export (scale 1) finishes inside the request budget, from the index only", async () => {
  const t = await crmTest({});
  try {
    const owner = await t.user("owner");
    const ex = generate({ scale: 1, seed: 7 });
    // the contacts index as the import leaves it: one row per customer and lead (built with the contacts module's own row())
    const rows = {};
    let n = 0;
    for (const c of [...ex.customers, ...ex.leads]) {
      n += 1;
      const id = `ct_${String(n).padStart(20, "0")}`;
      const lead = !("first_name" in c) || c.stage !== undefined;
      const [first, ...rest] = String(c.name || `${c.first_name || ""} ${c.last_name || ""}`).trim().split(/\s+/);
      const rec = { id, first_name: c.first_name || first || "", last_name: c.last_name || rest.join(" "), phones: c.phone ? [{ e164: c.phone, primary: true, sms: true }] : [], emails: c.email ? [{ address: c.email, primary: true }] : [],
        billing_address: c.address ? { street1: c.address.street1, city: c.address.city, zip: c.address.zip } : null, lifecycle: lead ? "lead" : c.status === "inactive" ? "former_customer" : "customer", source: { source: c.source || "" }, tags: c.tags || [], flags: {}, updated_at: "2026-11-10T00:00:00.000Z" };
      rows[id] = { contact: { wv: 1, d: contactRow(rec) } };
    }
    assert.ok(n > 1200, `${n} contacts`);
    await store.settledWrite("ix/contacts", { v: 1, name: "contacts", shard: "", rows }, { onlyIfNew: true });
    await store.createRecord("template", { key: "fall_note", name: "Fall note", channel: "sms", category: "marketing", body: "Hi {{first_name|there}}, fall cleanings are open.", tags: [], active: true }, W(owner.id));
    const made = await t.api("/campaigns", { method: "POST", as: owner, body: { name: "Everyone in Delano", channel: "sms", template_key: "fall_note", audience: { lifecycle: ["customer", "lead"], towns: ["Delano"] } } });
    const S = t.stores.data;
    const mark = S.calls.length;
    const t0 = performance.now();
    const res = await t.api(`/campaigns/${made.body.data.id}/preview`, { method: "POST", as: owner, body: {} });
    const ms = performance.now() - t0;
    assert.equal(res.status, 200, "inside the route's storage budget (one call too many answers 503)");
    assert.ok(ms < 8000, `${Math.round(ms)} ms`);
    const calls = S.calls.slice(mark);
    assert.ok(calls.filter((c) => /^rec\/contact\//.test(c.key || "")).length <= 10, "the only contact records read are the ten for the sample texts");
    assert.equal(calls.filter((c) => c.op === "list" && /^rec\//.test(c.key || "")).length, 0, "no record listing");
    assert.equal(calls.filter((c) => /^ix\/contacts/.test(c.key || "")).length, 1, "the contacts index, once");
    // the count is the fixture query's
    const flat = Object.entries(rows).map(([id, v]) => ({ id, ...v.contact.d }));
    const want = evaluateAudience(flat, { lifecycle: ["customer", "lead"], towns: ["Delano"] }, { channel: "sms" });
    assert.ok(want.count > 20);
    assert.deepEqual([res.body.data.count, res.body.data.matched, res.body.data.excluded], [want.count, want.matched, want.excluded]);
    process.stdout.write(`# audience preview at scale 1: ${n} contacts, ${want.count} recipients, ${calls.length} storage calls, ${Math.round(ms)} ms\n`);
  } finally { t.done(); }
});
