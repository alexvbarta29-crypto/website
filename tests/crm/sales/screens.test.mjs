// The sales screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation is escaped, tel:/sms: links stay in
// the frame, and each screen says what it should. The phone walk
// (Playwright) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/sales/${name}.js`)).default;
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner", first_name: "Olive" }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const NOW = "2026-11-17T15:00:00.000Z";
const XSS = "</script><script>alert(1)</script>";

const row = (o = {}) => ({
  id: "en_00000000000000000001", contact_id: "ct_00000000000000000001", name: `Pat ${XSS}`, phone: "+17635550100", town: "Delano", cadence: "New lead - no estimate yet",
  cadence_key: "new_lead", n: 1, label: "Day 1 - Call + VM/Text (1)", action: "call_then_text", rbs: false, due: "2026-11-17T15:00:00.000Z", due_end: "2026-11-17T16:00:00.000Z",
  status: "active", pending: null, started_at: "2026-11-17T14:55:00.000Z", last_touch_at: null, overdue: false, ...o,
});

test("Leads & calls: windows, overdue on top, Call (tel:), Log, the waiting text, the dry-run note; all escaped", async () => {
  const calls = await load("calls");
  const s = {
    tab: "due", sms_mode: "dry_run", due: [row({ id: "en_1", overdue: true, due: "2026-11-17T15:00:00.000Z", due_end: "2026-11-17T16:00:00.000Z" }), row({ id: "en_2", pending: "hand", due: "2026-11-17T18:00:00.000Z", due_end: "2026-11-17T19:00:00.000Z" })],
    later: [row({ id: "en_3", due: "2026-11-17T22:00:00.000Z", due_end: "2026-11-17T23:00:00.000Z" })], upcoming: [], paused: [row({ id: "en_4", status: "paused", paused_reason: "spoke", paused_at: NOW })],
    attention: [{ contact_id: "ct_1", name: "Sam Sample", reasons: ["untouched", "overdue"], enrollment_id: "en_1" }], counts: { attention: 1 },
  };
  const h = text(calls.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"), "names are escaped");
  assert.match(h, /href="tel:\+17635550100"/);
  assert.match(h, /data-call="en_1"/);
  assert.match(h, /data-log="en_2"/);
  assert.ok(h.indexOf("Overdue") < h.indexOf("12:00–1:00 PM"), "overdue on top, then the windows");
  assert.match(h, /Text waiting: did you send it\?/);
  assert.match(h, /Texts don't leave the CRM yet/);
  assert.match(h, /Due now <span class="n">2<\/span>/);
  assert.match(text(calls.render({ ...s, tab: "later" }, ctx())), /4:00–5:00 PM/);
  const p = text(calls.render({ ...s, tab: "paused" }, ctx()));
  assert.match(p, /after a call/);
  assert.match(p, /data-resume="en_4"/);
  assert.match(text(calls.render({ ...s, tab: "attention" }, ctx())), /No call or text in a day · Step overdue/);
  assert.doesNotMatch(text(calls.render({ ...s, sms_mode: "live" }, ctx())), /Texts don't leave the CRM yet/);
  assert.match(text(calls.render({ ...s, due: [], later: [] }, ctx())), /No calls due right now/);
});

test("the sheets: how did it go, the text to send by hand (Copy / Messages / Did you send it?), the compose sheet", async () => {
  const kit = await import("../../../crm-app/modules/sales/kit.js");
  assert.equal(kit.smsHref("+17635550100", "Hi & bye"), "sms:+17635550100?&body=Hi%20%26%20bye");
  assert.equal(kit.telHref("+1 (763) 555-0100"), "tel:+17635550100");
  assert.equal(kit.blockedLabel("opted_out"), "they opted out");
  assert.equal(kit.OUTCOMES.length, 6);
  assert.equal(kit.winLabel({ due: "2026-11-17T15:00:00.000Z", due_end: "2026-11-17T16:00:00.000Z" }), "9:00–10:00 AM");
});

test("One follow-up, a deal, starting one, logging a call: render and escape", async () => {
  const en = await load("enrollment");
  const steps = [{ n: 1, day: 1, window: { start: "09:00", end: "10:00" }, action: "call_then_text", template_key: "cad_new_1", label: "Day 1 - Call + VM/Text (1)" }, { n: 2, day: 1, window: { start: "12:00", end: "13:00" }, action: "call_then_text", template_key: "cad_new_2", label: `Step ${XSS}` }];
  const s = {
    enrollment: { id: "en_1", status: "active", step_n: 2, cadence_key: "new_lead", started_at: NOW, next_due_at: "2026-11-17T18:00:00.000Z", due_end: "2026-11-17T19:00:00.000Z", cur: { label: "Day 1 - Call/Text (2)" }, deal_id: "dl_1",
      history: [{ n: 1, at: NOW, action: "call", outcome: "no_answer", double_dial: true }, { n: 1, at: NOW, action: "text", sent_by_hand: "sms_link" }] },
    cadence: { id: "cd_1", name: "New lead - no estimate yet", steps }, contact: { id: "ct_1", name: "Pat Example", phone: "+17635550100" },
    preview: { text: `Hey Pat ${XSS}`, sms_href: "sms:+17635550100?&body=Hey" }, sms_mode: "dry_run",
  };
  const h = text(en.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /Call: No answer \(twice\)/);
  assert.match(h, /Text sent by hand \(Messages\)/);
  assert.match(h, /href="#\/deals\/dl_1"/);
  assert.match(h, /data-act="pause"/);
  assert.match(h, /Copy text/);
  const ended = text(en.render({ ...s, enrollment: { ...s.enrollment, status: "stopped", stop_reason: "opted_out", ended_at: NOW } }, ctx()));
  assert.match(ended, /opted out of texts/);
  assert.doesNotMatch(ended, /data-act="pause"/);

  const deal = await load("deal");
  const d = text(deal.render({ deal: { id: "dl_1", title: `Windows ${XSS}`, status: "lost", lost_reason: "price", lost_at: NOW, opened_at: NOW, value_cents: 24310, services: ["Exterior Window Cleaning"], history: [{ at: NOW, kind: "rotor_opportunity", pipeline: "New Lead - No Estimate Yet", stage: "Day 1 - Call + VM/Text (1)", status_raw: "Lost" }] }, contact: { id: "ct_1", name: "Pat" }, enrollments: [] }, ctx()));
  assert.ok(!d.includes("<script>alert(1)"));
  assert.match(d, /\$243\.10/);
  assert.match(d, /From Rotor/);
  assert.match(d, /Price/);

  const enroll = await load("enroll");
  assert.match(text(enroll.render({ contact: { id: "ct_1", name: "Pat" }, cadences: [{ key: "new_lead", name: "New lead - no estimate yet" }], enrollments: [], pick: "new_lead" }, ctx())), /name="cadence"[^>]*checked|checked[^>]*name="cadence"/);

  const log = await load("log");
  const l = text(log.render({ who: { contact_id: "ct_1", name: "Pat", phone: "+17635550100" }, direction: "out", outcome: "spoke", fixed: true }, ctx()));
  assert.match(l, /data-outcome="spoke"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-outcome="spoke"/);
  assert.match(text(log.render({ who: null, direction: "in", outcome: "no_answer", fixed: false }, ctx())), /pauses their follow-up/);
});

test("Tasks, one task, the contact's Sales tab, the Today card, Settings → Cadences", async () => {
  const tasks = await load("tasks");
  const list = [{ id: "tk_1", title: `Incident: cracked pane ${XSS}`, kind: "incident", priority: "high", status: "open", reported_on: "2026-11-10", contact_name: "Pat" }, { id: "tk_2", title: "Casey On-site quote", kind: "estimate_visit", priority: "medium", status: "open", due_at: "2026-11-20T15:00:00.000Z", end_at: "2026-11-20T16:00:00.000Z" }];
  const h = text(tasks.render({ office: true, tab: "all", mine: [], all: list }, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /Reported (today|\d+ days? ago)/, "days since it was reported");
  assert.match(h, /data-done="tk_1"/);
  assert.match(text(tasks.render({ office: true, tab: "incident", mine: [], all: list }, ctx())), /cracked pane/);
  assert.doesNotMatch(text(tasks.render({ office: false, tab: "mine", mine: [list[1]], all: [] }, ctx(["tasks:read"]))), /role="tablist"/, "a tech sees their own list only");

  const task = await load("task");
  const office = text(task.render({ isNew: true, office: true, users: [{ id: "us_1", name: "Olive Owner" }], task: { kind: "estimate_visit", priority: "medium", status: "open", assignee_ids: ["us_1"] } }, ctx()));
  assert.match(office, /name="end_time"/, "an estimate visit has an end");
  assert.match(office, /name="who_us_1"[^>]*checked|checked[^>]*name="who_us_1"/);
  const tech = text(task.render({ isNew: false, office: false, users: [], task: { id: "tk_2", title: "Touch-up", kind: "touch_up", status: "open" } }, ctx(["tasks:read"])));
  assert.match(tech, /data-status="done"/);
  assert.doesNotMatch(tech, /name="notes"/);

  const tab = await load("contact-tab");
  const t = text(tab.render({ contact: { id: "ct_1", name: "Pat" }, enrollments: [{ id: "en_1", cadence_name: `New lead ${XSS}`, status: "active", cur: { label: "Day 1" }, next_due_at: NOW, due_end: "2026-11-17T16:00:00.000Z" }], deals: [{ id: "dl_1", title: "Windows", status: "open", opened_at: NOW }], tasks: [], sales: { last_called_at: NOW } }, ctx()));
  assert.ok(!t.includes("<script>alert(1)"));
  assert.match(t, /href="#\/calls\/log\/ct_1"/);
  assert.match(t, /href="#\/sales\/enroll\/ct_1"/);
  assert.match(t, /href="#\/enrollments\/en_1"/);
  assert.match(text(tab.render({ denied: true }, ctx([]))), /Not for this login/);

  const card = await load("today-card");
  assert.match(text(card.render({ calls: { due: 3, overdue: 1, attention: 2 }, tasks: [{}, {}] }, ctx())), /3 calls due, 1 late[\s\S]*2 leads need a call[\s\S]*2 tasks for you/);
  assert.equal(text(card.render({ calls: { due: 0, attention: 0 }, tasks: [] }, ctx())), "");

  const cadences = await load("cadences");
  const c = text(cadences.render({ list: [{ id: "cd_1", key: "new_lead", name: "New lead - no estimate yet", active: true, steps: 10, entry_on: "lead.created", unattended: "wait" }, { id: "cd_2", key: "referrals", name: "Referrals", active: false, board_only: true, steps: 0 }], sales: { data: { attention_hours: 24 } }, ack: { settings: { delay: 5 } } }, ctx()));
  assert.match(c, /10 steps · starts when: A new lead/);
  assert.match(c, /Board only/);
  assert.match(c, /waits 5 minutes/);
  const cadence = await load("cadence");
  const est = { id: "cd_2", key: "estimate_followup", name: "Estimate sent - not scheduled", active: true, entry: { on: "quote.sent" }, on_reply: "pause", unattended: "wait",
    steps: [{ n: 1, day: 1, window: { start: "09:00", end: "10:00" }, action: "call_then_text", template_key: "cad_est_1", review_before_send: true, label: "Day 1" }] };
  const e = text(cadence.render({ c: est, templates: [{ key: "cad_est_1", name: "Follow-up: Estimate day 1 morning" }] }, ctx()));
  assert.doesNotMatch(e, /value="text_anyway"/, "a read-before-sending cadence never offers text anyway");
  assert.match(e, /never go out on their own/);
  assert.match(e, /name="rbs_0"[^>]*checked|checked[^>]*name="rbs_0"/);
});

test("the client manifest: routes with parents and permissions, the Sales contact tab, Settings → Cadences", async () => {
  const m = (await import("../../../crm-app/modules/sales/manifest.js")).default;
  for (const r of m.routes) {
    assert.ok(r.perm, `${r.path} has a permission`);
    assert.ok(r.parent, `${r.path} names its parent`);
  }
  assert.ok(m.contactTabs.some((t) => t.key === "sales"));
  assert.ok(m.settings.some((s) => s.path === "/settings/cadences" && s.perm === "cadences:configure"));
  assert.ok(m.nav.some((n) => n.path === "/calls" && n.perm === "sales:work"));
  assert.ok(m.todayCards.length === 1);
});
