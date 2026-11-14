// M8 screens: the switch from Rotor (checklist, preview, runbook) and the
// automatic daily import render with synthetic state through html``: values
// escaped, the switch disabled until every item is green, the owner's items
// are tick boxes, the typed words are the server's, no key or hash shown
// after it was made. The phone walk (Playwright) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/import/${name}.js`)).default;
const ctx = { can: () => true, user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, params: {} };
const text = (safe) => String(safe);
const NOW = "2027-01-04T15:00:00.000Z";
const item = (key, group, kind, state, extra = {}) => ({ key, group, label: `${key} <b>label</b>`, kind, state, ...extra });
const base = (over = {}) => ({
  items: [item("setup", "Platform", "auto", "ok"), item("stripe", "Accounts", "auto", "todo", { detail: "Settings, Integrations: connect it" }), item("rotor_off", "Data", "owner", "todo"), item("preview", "Preview approved", "auto", "todo")],
  ready: false, rehearsal: false, mode: { system_of_record: "rotor", cutover_n: 0, cutover_at: null, paused: false },
  preview: null, history: [], active: null, rollback: null, rollback_list: [], confirm: { switch: "SWITCH TO CRM", rollback: "SWITCH BACK TO ROTOR" },
  in_flight: { quotes: { label: "Quotes sent in the last 30 days", count: 3, bulk_run_id: null }, invoices: { label: "Open invoices from Rotor", count: 0, bulk_run_id: null }, agreements: { label: "Agreements not signed yet", count: 1, bulk_run_id: "bk_00000000000000000001" } },
  ...over,
});

test("the checklist: red and green items, the owner's ticks, the switch waits for every item", async () => {
  const s = await load("cutover-checklist");
  const h = text(s.render(base(), ctx));
  assert.match(h, /Rotor is in charge/);
  assert.match(h, /3 to do/);
  assert.match(h, /stripe &lt;b&gt;label&lt;\/b&gt;/, "escaped");
  assert.match(h, /<input type="checkbox" data-tick="rotor_off">/, "an owner item is a tick box");
  assert.doesNotMatch(h, /data-tick="stripe"/, "what the CRM checks is not");
  assert.match(h, /<button type="button" class="btn primary" data-switch disabled>Switch to the CRM<\/button>/);
  assert.match(h, /Finish the checklist first/);
  assert.match(h, /Make the preview/);
  assert.match(h, /data-inflight="quotes"/);
  assert.match(h, /<button type="button" class="btn co-btn" data-inflight="invoices" disabled>/, "an empty list can't be sent");
  assert.match(h, /href="#\/approvals"/, "a list made is tested and confirmed under Approvals");
  assert.match(h, /href="#\/cutover\/runbook"/);
  const ready = text(s.render(base({ ready: true, items: base().items.map((i) => ({ ...i, state: "ok" })), preview: { status: "done", at: NOW, created_at: NOW, computed_at: NOW, totals: { texts: 14, emails: 3, invoices: 0, charges: 0 }, approved_at: NOW, current: true } }), ctx));
  assert.match(ready, /<button type="button" class="btn primary" data-switch\s*>Switch to the CRM<\/button>/);
  assert.match(ready, /All green/);
  assert.match(ready, /<b>14<\/b><span>texts<\/span>/);
  assert.match(ready, /Approved/);
  const rehearsal = text(s.render(base({ rehearsal: true }), ctx));
  assert.match(rehearsal, /isn't the production site/);
});

test("after the switch: the 48 hours to go back, then not; what to enter in Rotor after a rollback", async () => {
  const s = await load("cutover-checklist");
  const crm = text(s.render(base({ mode: { system_of_record: "crm", cutover_n: 1, cutover_at: NOW }, rollback: { allowed: true, until: "2027-01-06T15:00:00.000Z" }, history: [{ kind: "cutover", n: 1, status: "done", at: NOW }] }), ctx));
  assert.match(crm, /The CRM is in charge/);
  assert.match(crm, /data-rollback/);
  assert.match(crm, /Switch to the CRM #1/);
  assert.doesNotMatch(crm, /data-switch/);
  const late = text(s.render(base({ mode: { system_of_record: "crm", cutover_n: 1, cutover_at: NOW }, rollback: { allowed: false, until: NOW } }), ctx));
  assert.doesNotMatch(late, /data-rollback/);
  assert.match(late, /48 hours to go back to Rotor are over/);
  const back = text(s.render(base({ mode: { system_of_record: "rotor", cutover_n: 1, cutover_at: NOW }, rollback_list: [{ type: "quote", id: "qt_00000000000000000001", label: "Q-18641", contact_id: "ct_00000000000000000001", at: NOW }] }), ctx));
  assert.match(back, /To enter in Rotor/);
  assert.match(back, /Quote Q-18641/);
  assert.match(back, /Rotor is in charge again/);
});

test("the preview: per day and per automation, seeds, the floor, numbers; samples escaped", async () => {
  const s = await load("cutover-preview");
  const z = { texts: 0, emails: 0, invoices: 0, charges: 0 };
  const result = {
    at: NOW, days: ["2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07"],
    by_day: [{ date: "2027-01-04", texts: 2, emails: 1, invoices: 0, charges: 0 }, { date: "2027-01-05", ...z }, { date: "2027-01-06", ...z }, { date: "2027-01-07", ...z }], totals: { texts: 2, emails: 1, invoices: 0, charges: 0 },
    automations: [
      { key: "visit.reminder_2d", label: "Reminder 2 days before", kind: "daily", enabled: true, by_day: [{ ...z, texts: 1 }, z, z, z], total: { ...z, texts: 1 }, note: null, samples: ["REMINDER: Hi <Robin>, see you Tue"] },
      { key: "lead.ack", label: "Thank a new lead by text", kind: "on_activity", enabled: true, by_day: [z, z, z, z], total: z, note: "Only when a new lead comes in after the switch", samples: [] },
    ],
    seeds: { reminder: 2, overdue: 1, receipt: 1, agreement: 1, unmatched: { reminder: 1 } }, floor: { imported_completed_jobs: 4, imported_invoices: 7 }, sequences: { dry_sends: 3, follow_ups: 2 }, numbers: { job: 885, invoice: 610, quote: 18641 },
  };
  const h = text(s.render({ state: { status: "done", approved_at: null }, result }, ctx));
  assert.match(h, /Mon Jan 4/);
  assert.match(h, /All 72 hours/);
  assert.match(h, /REMINDER: Hi &lt;Robin&gt;/, "a sample is escaped");
  assert.match(h, /0000885/);
  assert.match(h, /INV-0610/);
  assert.match(h, /Q-18641/);
  assert.match(h, /4 jobs Rotor completed this past week: never asked/);
  assert.match(h, /7 open invoices from Rotor: never reminded/);
  assert.match(h, /Only when a new lead comes in/);
  assert.match(h, /Not matched/);
  const none = text(s.render(null, ctx));
  assert.match(none, /No preview yet/);
});

test("the runbook: every step of switch day in order, Rotor's steps are the owner's", async () => {
  const s = await load("cutover-runbook");
  const mod = await import("../../../crm-app/modules/import/cutover-runbook.js");
  const h = text(s.render({}, ctx));
  assert.match(h, /Switch day, step by step/);
  assert.ok(mod.STEPS.length >= 10);
  assert.match(h, /switch off its workflows yourself/);
  assert.match(h, /Cancel Rotor yourself/);
  for (const st of mod.STEPS) assert.ok(!/—/.test(st.what), "no em dash");
});

test("the automatic daily import: the key's last four only, revoke, the latest automatic imports", async () => {
  const s = await load("auto-key");
  const mod = await import("../../../crm-app/modules/import/auto-key.js");
  const on = text(s.render({ key: { id: "ik_00000000000000000001", name: "Daily <import>", last4: "WXYZ", created_at: NOW, last_used_at: NOW, uses: 3, active: true }, earlier: [{ id: "ik_00000000000000000002", name: "Old", last4: "ABCD", created_at: NOW, revoked_at: NOW, uses: 9 }], runs: [{ id: "ir_00000000000000000001", status: "done", as_of: "2027-01-03", created_at: NOW, summary: { created: 4, updated: 12, conflicts: 0 } }], per_day: 4 }, ctx));
  assert.match(on, /…WXYZ · Daily &lt;import&gt;/);
  assert.match(on, /data-revoke="ik_00000000000000000001"/);
  assert.match(on, /4 added · 12 updated/);
  assert.match(on, /Revoked/);
  assert.doesNotMatch(on, /bauto_/, "the key itself is never on the screen after it was made");
  const off = text(s.render({ key: null, earlier: [], runs: [], per_day: 4 }, ctx));
  assert.match(off, /the daily import is off/);
  assert.match(off, /Make the key/);
  assert.match(mod.AUTO_COMMAND, /--key-file/);
  assert.doesNotMatch(mod.AUTO_COMMAND, /bauto_|CRM_UPLOAD_KEY/, "the key never goes on a command line");
});

test("Import from Rotor leads to the daily import and, for owners, the switch-over", async () => {
  const list = await load("list");
  const on = text(list.render({ runs: [], rest: null, auto: { key: { id: "ik_00000000000000000001" } }, cutover: true }, ctx));
  assert.match(on, /href="#\/import\/auto"/);
  assert.match(on, /See the key/);
  assert.match(on, /<span class="pill green">On<\/span>/);
  assert.match(on, /href="#\/cutover"/);
  const office = text(list.render({ runs: [], rest: null, auto: { key: null }, cutover: false }, ctx));
  assert.doesNotMatch(office, /href="#\/cutover"/, "only who may switch sees the way to it");
  assert.match(office, /Set it up/);
});
