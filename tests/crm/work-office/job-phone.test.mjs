// The job page on a phone (Nov 2026: Rotor's phone job page with Flyra's
// top, office-job-phone.js) renders through html`` with synthetic state:
// the title block, the step button and its 4-step bar, the address, the
// quick row, the plan card, Amount due with Checkout, the customer, Pricing
// as a card a line ("Added on site"), Invoices, Job notes, Delete Job and
// the floating "N left" pill; a desk keeps the two columns. Escaped.
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

test("a phone: Flyra's top, then Rotor's cards, the pill; escaped; a desk keeps the two columns", async () => {
  globalThis.window = { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
  phoneMedia(true);
  try {
    const page = (await import("../../../crm-app/modules/work/office-job.js")).default;
    const s = state();
    const h = text(page.render(s, ctx()));
    assert.ok(!h.includes("<script>alert(1)"), "escaped");
    assert.match(h, /class="jp-title">Window cleaning [^<]*- Service #2</, "the title with the plan visit's number");
    assert.match(h, /Pat &lt;\/script&gt;[^<]*· S-000491/);
    assert.match(h, /Mon, Nov 16[\s\S]*8:00–10:30 AM[\s\S]*2 hrs 30 min/, "the day, the time and Rotor's duration chip");
    assert.match(h, /data-v-omw="vs_1"[^>]*>[\s\S]*On my way/, "the big step for the visit's own people");
    assert.match(h, /<ol class="jp-bar"[\s\S]*On my way[\s\S]*Arrive[\s\S]*Start Job[\s\S]*Complete Job/, "Flyra's 4 steps");
    assert.match(h, /class="rs-card rs-addr"/);
    assert.match(h, /class="jp-quick"[\s\S]*Reschedule[\s\S]*Invoice[\s\S]*Callback[\s\S]*More/);
    assert.match(h, /jp-plan[\s\S]*Quarterly · \$625\.00 \/ visit[\s\S]*No card on file[\s\S]*Add card on file/, "the plan card");
    assert.doesNotMatch(h, /jp-due/, "booked, nothing invoiced: no Amount due yet");
    assert.match(h, /class="rs-card rs-person"[\s\S]*href="tel:\+17635550100"/);
    assert.match(h, /jp-tag">Added on site<\/span><span class="jp-av" title="Theo &lt;\/script&gt;/, "the tech's line, with who added it");
    assert.match(h, /data-line-photo="ln_1"[^>]*aria-label="A photo of Exterior Window Cleaning, 1 so far"/);
    assert.match(h, /Subtotal[\s\S]*\$725\.00[\s\S]*data-disc="dc_1"[\s\S]*Add discount[\s\S]*Total[\s\S]*\$625\.00[\s\S]*Create Invoice/);
    assert.match(h, /Invoices[\s\S]*No invoices yet/);
    assert.match(h, /Job notes[\s\S]*data-notes="crew"[\s\S]*data-notes-upload/);
    assert.match(h, /Sold by Olive Owner[\s\S]*Edit on the service plan/);
    assert.match(h, /data-del-job>Delete Job</);
    assert.match(h, /class="ck-pill"[^>]*data-ck-open="vs_1"[^>]*aria-label="Checklist: 0 of 3 done"[\s\S]*3 left/, "the floating pill");
    assert.equal(page.tools(s, ctx()).length, 1, "Rotor's round check beside the ...");
    // under way and owed: Complete Job (the checklist first), Amount due with Checkout and the three ways to pay
    const owed = state({ job: { status: "in_progress" }, visits: [{ id: "vs_1", date: "2026-11-16", start: "08:00", end: "10:30", status: "in_progress", assignee_ids: [ME], checklist: { items: ITEMS.map((i, n) => (n < 2 ? { ...i, done_at: "t" } : i)) } }] });
    const oh = text(page.render(owed, ctx()));
    assert.match(oh, /data-v-done="vs_1"[\s\S]*Complete Job/);
    assert.match(oh, /<li class="on"><i aria-hidden="true"><\/i><span>On my way<\/span><\/li><li class="on">[\s\S]*Arrive[\s\S]*<li class="on">[\s\S]*Start Job/);
    assert.match(oh, /Amount due[\s\S]*\$625\.00[\s\S]*data-checkout[\s\S]*data-pay-link[\s\S]*Send link[\s\S]*data-pay-qr[\s\S]*QR code[\s\S]*data-pay-cash[\s\S]*Cash or check/);
    assert.match(oh, /All done|1 left/);
    // a tech: no office cards
    globalThis.window = { __crm: { session: { perms: { "schedule:read": false } } } };
    const th = text(page.render(state(), ctx(["visits:work"], TECH)));
    assert.doesNotMatch(th, /jp-quick|jp-plan|jp-due|data-del-job|Invoices/);
    assert.match(th, /data-v-omw="vs_1"/, "the tech's own step");
    // a desk: the Rotor-desktop columns
    globalThis.window = { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
    phoneMedia(false);
    const dh = text(page.render(s, ctx()));
    assert.match(dh, /class="wk-jgrid"/);
    assert.doesNotMatch(dh, /jp-head/);
    assert.equal(page.tools(s, ctx()).length, 0);
  } finally { delete globalThis.window; delete globalThis.matchMedia; }
});

test("phone helpers: the visit's length, Flyra's steps done, the big step for someone not on the visit", async () => {
  const P = await import("../../../crm-app/modules/work/office-job-phone.js");
  assert.equal(P.lengthText({ start: "08:00", end: "10:00" }), "2 hrs");
  assert.equal(P.lengthText({ start: "08:00", end: "09:00" }), "1 hr");
  assert.equal(P.lengthText({ start: "08:00", end: "08:45" }), "45 min");
  assert.equal(P.lengthText({ start: "10:00", end: "08:00" }), "");
  assert.equal(P.stepsDone(null), 0);
  assert.equal(P.stepsDone({ status: "scheduled" }), 0);
  assert.equal(P.stepsDone({ status: "en_route" }), 1);
  assert.equal(P.stepsDone({ status: "in_progress" }), 3);
  assert.equal(P.stepsDone({ status: "completed" }), 4);
  const s = { job: { status: "scheduled" }, visits: [{ id: "v", status: "scheduled", assignee_ids: ["us_t"] }], can: { complete: true, add_visit: true } };
  assert.equal(P.bigStep(s, { user: { id: "us_o" } }, s.visits[0]), null, "the office isn't on it: no step");
  assert.equal(P.bigStep({ ...s, job: { status: "unscheduled" }, visits: [] }, { user: { id: "us_o" } }, null).label, "Book a visit");
  assert.equal(P.bigStep({ ...s, visits: [{ id: "v", status: "completed" }] }, { user: { id: "us_o" } }, null).label, "Mark done");
});
