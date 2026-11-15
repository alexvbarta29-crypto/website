// The job page on a phone, just like Rotor's (Nov 2026, office-job-phone.js)
// renders through html`` with synthetic state: the visit card (the day, the
// round calendar and "...", the time and its length, who goes, Start visit
// and On My Way), the customer, the address, Pricing (a row a line, "Added
// on site", + Item, the discount's pencil, + Add discount, Total, Create
// Invoice), Invoices, Job notes, Sold by and the floating "N left" pill; the
// rest (Checkout, the plan, a photo of a line, Cancel job) in the "...". A
// desk keeps the two columns. Escaped.
import { test } from "node:test";
import assert from "node:assert/strict";

const XSS = "</script><script>alert(1)</script>";
const ME = "us_00000000000000000001", TECH = "us_0000000000000000000t";
const users = [{ id: ME, name: "Olive Owner", color: "#2a78d6" }, { id: TECH, name: `Theo ${XSS}`, color: "#13a165" }];
const ctx = (perms = null, me = ME) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: me, role: "owner" }, keep: {}, path: "/x", params: {} });
const text = (x) => String(x);
const phoneMedia = (on) => { globalThis.matchMedia = (q) => ({ matches: on && /max-width: 699px/.test(q), addEventListener() {}, removeEventListener() {} }); };

const ITEMS = [
  { key: "omw_text", label: 'Send "On My Way" Text', required: true, kind: "check", hook: "on_my_way" },
  { key: "arrive_start", label: 'Arrive + Mark "Start Job"', required: true, kind: "check", hook: "start" },
  { key: "notes", label: "Any Notes (Optional)", required: false, kind: "text" },
];
function state(o = {}) {
  return {
    job: { id: "jb_1", number_label: "S-000491", title: `Window cleaning ${XSS}`, kind: "standard", status: "scheduled", billable: true, contact_id: "ct_1", invoice_ids: [], plan_id: "pl_1", plan_ordinal: { term: 1, n: 2 },
      created_at: "2026-11-12T03:46:00.000Z",
      lines: [{ id: "ln_1", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 44500, total_cents: 44500 }, { id: "ln_2", title: `Interior ${XSS}`, qty_milli: 1000, unit_cents: 28000, total_cents: 28000, upsell_user_id: TECH }],
      discounts: [{ id: "dc_1", name: "Discount", type: "fixed", value: 10000 }], totals: { subtotal_cents: 72500, discount_cents: 10000, total_cents: 62500 }, crew_notes: "Synthetic gate", office_notes: "", ...(o.job || {}) },
    visits: o.visits || [{ id: "vs_1", date: "2026-11-16", start: "08:00", end: "10:30", status: "scheduled", assignee_ids: [ME, TECH], checklist: { name: "Technician Job Checklist", items: ITEMS }, photos: [{ file_id: "fl_1", line: "ln_1" }] }],
    contact: { id: "ct_1", display_name: `Pat ${XSS}`, phones: [{ e164: "+17635550100", primary: true }] },
    property: { id: "pr_1", address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" } },
    people: { [ME]: { id: ME, name: "Olive Owner" }, [TECH]: { id: TECH, name: "Theo Tech" } },
    can: { write: true, add_visit: true, complete: true, cancel: true, reopen: false }, users, invoices: o.invoices || [], quote: null,
    plan: { id: "pl_1", name: `Quarterly ${XSS}`, status: "active", sold_by: ME }, planCard: o.planCard || { status: "none" }, planFeatures: { money: true }, planFreq: "Quarterly",
  };
}

test("a phone: Rotor's job page, card after card; the rest in the \"...\"; escaped; a desk keeps the two columns", async () => {
  globalThis.window = { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
  phoneMedia(true);
  try {
    const page = (await import("../../../crm-app/modules/work/office-job.js")).default;
    const s = state();
    const h = text(page.render(s, ctx()));
    assert.ok(!h.includes("<script>alert(1)"), "escaped");
    assert.match(h, /class="jp-vday"><a href="#\/visits\/vs_1">Nov 16</, "the big day, opening the visit");
    assert.match(h, /data-v-move="vs_1"[^>]*>[\s\S]*data-jp-vmore/, "the round calendar (reschedule) and the round ...");
    assert.match(h, /8:00 AM – 10:30 AM[\s\S]*2 hrs 30 min/, "the time and Rotor's length chip");
    assert.match(h, /Olive Owner[\s\S]*Theo &lt;\/script&gt;/, "who goes");
    assert.match(h, /class="jp-pill red" data-v-start="vs_1"[\s\S]*Start visit[\s\S]*data-v-omw="vs_1"[\s\S]*On My Way/, "Start visit, then On My Way");
    assert.ok(h.indexOf("jp-visit") < h.indexOf("rs-person") && h.indexOf("rs-person") < h.indexOf("rs-addr") && h.indexOf("rs-addr") < h.indexOf("jp-pricing"), "visit, customer, address, Pricing");
    assert.match(h, /class="rs-card jp-card jp-row rs-person"[\s\S]*href="tel:\+17635550100"/);
    assert.match(h, /jp-tag">Added on site<\/span><span class="jp-av" title="Theo &lt;\/script&gt;/, "the tech's line, with who added it");
    assert.match(h, /data-add-line[\s\S]*Subtotal[\s\S]*\$725\.00[\s\S]*data-disc="dc_1"[\s\S]*Add discount[\s\S]*Total[\s\S]*\$625\.00[\s\S]*Create Invoice/);
    assert.match(h, /Invoices[\s\S]*No invoices yet/);
    assert.match(h, /Job notes[\s\S]*data-notes="crew"[\s\S]*data-notes-upload/);
    assert.match(h, /Sold by Olive Owner[\s\S]*Edit on the service plan/);
    assert.match(h, /class="ck-pill"[^>]*data-ck-open="vs_1"[^>]*aria-label="Checklist: 0 of 3 done"[\s\S]*3 left/, "the floating pill");
    assert.doesNotMatch(h, /jp-title|jp-bar|jp-quick|jp-plan|jp-due|data-del-job|data-line-photo/, "no Flyra pieces");
    assert.equal(page.tools(s, ctx()).length, 1, "Rotor's round check beside the ...");
    assert.match(page.moreTitle(s), /Window cleaning/);
    const rows = page.more(s, ctx()).flat().filter(Boolean);
    for (const k of ["line-photos", "cancel", "make-invoice", "book"]) assert.ok(rows.some((r) => r.data && r.data[k] !== undefined), k);
    assert.ok(rows.some((r) => /^Quarterly/.test(r.label) && /no card on file/.test(r.hint || "")), "the plan, with its card");
    // under way and owed: Complete visit and Pause; Checkout and the ways to pay in the "..."
    const owed = state({ job: { status: "in_progress" }, visits: [{ id: "vs_1", date: "2026-11-16", start: "08:00", end: "10:30", status: "in_progress", assignee_ids: [ME], checklist: { items: ITEMS.map((i, n) => (n < 2 ? { ...i, done_at: "t" } : i)) } }] });
    const oh = text(page.render(owed, ctx()));
    assert.match(oh, /data-v-done="vs_1"[\s\S]*Complete visit[\s\S]*data-v-pause="vs_1"[\s\S]*Pause/);
    assert.match(oh, /All done|1 left/);
    const orows = page.more(owed, ctx()).flat().filter(Boolean);
    for (const k of ["checkout", "pay-link", "pay-qr", "pay-cash"]) assert.ok(orows.some((r) => r.data && r.data[k] !== undefined), k);
    assert.match(orows.find((r) => r.data && r.data.checkout !== undefined).hint, /\$625\.00/);
    // a tech: no office cards
    globalThis.window = { __crm: { session: { perms: { "schedule:read": false } } } };
    const th = text(page.render(state(), ctx(["visits:work"], TECH)));
    assert.doesNotMatch(th, /jp-invs|jp-sold|Invoices/);
    assert.match(th, /data-v-start="vs_1"[\s\S]*data-v-omw="vs_1"/, "the tech's own steps");
    // a desk: the Rotor-desktop columns
    globalThis.window = { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
    phoneMedia(false);
    const dh = text(page.render(s, ctx()));
    assert.match(dh, /class="wk-jgrid"/);
    assert.doesNotMatch(dh, /jp-visit/);
    assert.equal(page.tools(s, ctx()).length, 0);
  } finally { delete globalThis.window; delete globalThis.matchMedia; }
});

test("phone helpers: the day, the time, the length, the pills for someone not on the visit", async () => {
  const P = await import("../../../crm-app/modules/work/office-job-phone.js");
  assert.equal(P.dayText("2026-11-16"), "Nov 16");
  assert.equal(P.timeText({ start: "08:00", end: "10:30" }), "8:00 AM – 10:30 AM");
  assert.equal(P.lengthText({ start: "08:00", end: "10:00" }), "2 hrs");
  assert.equal(P.lengthText({ start: "08:00", end: "09:00" }), "1 hr");
  assert.equal(P.lengthText({ start: "08:00", end: "08:45" }), "45 min");
  assert.equal(P.lengthText({ start: "10:00", end: "08:00" }), "");
  const s = { job: { status: "scheduled" }, visits: [{ id: "v", status: "scheduled", assignee_ids: ["us_t"] }], can: { complete: true, add_visit: true } };
  assert.deepEqual(P.goPills(s, { user: { id: "us_o" } }, s.visits[0]), [], "the office isn't on it: no steps");
  assert.equal(P.goPills({ ...s, job: { status: "unscheduled" }, visits: [] }, { user: { id: "us_o" } }, null)[0].label, "Book a visit");
  assert.equal(P.goPills({ ...s, visits: [{ id: "v", status: "completed" }] }, { user: { id: "us_o" } }, null)[0].label, "Mark done");
  const mine = (status) => P.goPills(s, { user: { id: "us_t" } }, { id: "v", status, assignee_ids: ["us_t"] }).map((g) => g.label);
  assert.deepEqual(mine("scheduled"), ["Start visit", "On My Way"]);
  assert.deepEqual(mine("en_route"), ["Start visit", "On the way"]);
  assert.deepEqual(mine("in_progress"), ["Complete visit", "Pause"]);
  assert.deepEqual(mine("paused"), ["Resume", "Complete"]);
});
