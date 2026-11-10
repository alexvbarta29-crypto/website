// The M1.3 screens render with synthetic state through html`` (design §2.3,
// §0 rule 7): every interpolation lands where html`` allows it (no inline
// handler, no unsafe link), and each screen says what it should. A
// browser walk (Playwright, §12.4) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/system/${name}.js`)).default;
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner", first_name: "Olive" }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const NOW = "2026-11-17T15:00:00.000Z";

test("Outbox, Activity, Approvals, Notifications and Today render their rows", async () => {
  const outbox = await load("outbox");
  const items = [
    { id: "ob_1", kind: "sms", mode: "dry_run", to_masked: "(763) •••-0101", body: "Hi Pat <b>x</b>", created_at: NOW, origin: { kind: "automation", id: "visit.reminder_2d" }, simulated: { status: "sent" } },
    { id: "ob_2", kind: "email", mode: "blocked", blocked_reason: "opted_out", to_masked: "p•••@example.com", subject: "Fall", body: "Deal", created_at: NOW },
  ];
  const o = text(outbox.render({ date: "2026-11-17", tab: "outbox", kind: "", items, next: null, log: [] }, ctx()));
  assert.match(o, /\(763\) •••-0101/);
  assert.match(o, /Hi Pat &lt;b&gt;x&lt;\/b&gt;/, "bodies are escaped");
  assert.match(o, /opted out/);
  const l = text(outbox.render({ date: "2026-11-17", tab: "log", kind: "", items: [], log: [{ at: NOW, key: "quotes.expire", subject: "qt_1", result: "would-archive" }, { at: NOW, key: "x", subject: "ct_1", result: "skipped:imported" }] }, ctx()));
  assert.match(l, /Would have: archive/);
  assert.match(l, /Skipped: came from Rotor/);

  const activity = await load("activity");
  const a = text(activity.render({ date: "2026-11-17", user: "", type: "", rows: [{ at: NOW, type: "template", id: "tp_1", action: "update", actor: "us_00000000000000000001" }], users: [{ id: "us_00000000000000000001", name: "Olive Owner", first_name: "Olive" }] }, ctx()));
  assert.match(a, /Olive Owner changed template/);

  const approvals = await load("approvals");
  const ap = text(approvals.render({ bulk: [{ id: "bk_1", title: "Rain-day notice", status: "tested", recipients: 7, created_at: NOW }], pending: [{ id: "pa_1", title: "3 offline changes to review", created_at: NOW }], canApprove: true }, ctx()));
  assert.match(ap, /Rain-day notice/);
  assert.match(ap, /Ready to confirm/);
  assert.match(ap, /3 offline changes to review/);

  const notes = await load("notifications");
  const n = text(notes.render({ items: [{ id: "nt_1", kind: "approval", title: "Waiting for your OK", body: "2 offline", link: "/approvals", read_at: null, created_at: NOW }] }, ctx()));
  assert.match(n, /data-link="\/approvals"/);
  assert.match(n, /New/);

  const today = await load("today");
  const td = text(today.render({ now: new Date(NOW), user: { first_name: "Olive", role: "owner" }, badges: { notifications: 3, approvals: 2 }, health: { status: { fast: "stuck", bulk: "ok" }, alerts: [{ text: "No off-site copy" }] } }, ctx()));
  assert.match(td, /2 approvals waiting/);
  assert.match(td, /hasn't finished a pass/);
  assert.match(td, /Notifications, 3 new/);
});

test("Settings screens, Automations, Templates and My account render for an owner", async () => {
  const settings = await load("settings");
  assert.match(text(settings.render({ health: { status: { fast: "ok", bulk: "ok" }, lanes: {} } }, ctx())), /Team permissions/);
  assert.doesNotMatch(text(settings.render({ health: null }, ctx(["settings:general"]))), /Team permissions/, "owner-only sections hidden from the office");

  const general = await load("settings-general");
  const doc = (data) => ({ name: "x", data, etag: '"1"' });
  assert.match(text(general.render({ section: "company", company: doc({ name: "Barta Window Washing", base: { label: "Delano shop", lat: 45, lng: -93 } }) })), /Delano shop/);
  assert.match(text(general.render({ section: "hours", hours: doc({ 0: null, 1: ["08:00", "18:00"] }), calendar: doc({ rules: ["christmas"], dates: [] }), dates: ["2026-12-24"] })), /Christmas Day/);
  assert.match(text(general.render({ section: "area", area: doc({ center: { lat: 45, lng: -93 }, radius_mi: 20, towns: ["Delano"], zips: ["55328"] }) })), /55328/);

  const messaging = await load("settings-messaging");
  const m = text(messaging.render({ messaging: doc({ quiet: {}, footer: { text: " Reply STOP to opt out." }, bulk_threshold: 5 }), comms: doc({ reply_keywords: { enabled: false } }), test: doc({ contact_id: null }), words: [{ word: "YES", tag: "Replied YES", task: true }] }, ctx()));
  assert.match(m, /Reply STOP to opt out/);
  assert.match(m, /Pick the test contact/);

  const integrations = await load("settings-integrations");
  const st = { integrations: { sms: { setting: "dry_run", effective: "dry_run", secrets: { TWILIO_ACCOUNT_SID: false } }, push: { setting: "live", effective: "off", secrets: { CRM_VAPID_PUBLIC: false } } }, force_dry_run: false, paused: false };
  const i = text(integrations.render({ section: "integrations", status: st, doc: doc({ sms: { mode: "dry_run", number: "+17633143400" } }) }, ctx()));
  assert.match(i, /✕ TWILIO_ACCOUNT_SID/);
  assert.match(text(integrations.render({ section: "intake", doc: doc({ mode: "rotor" }) }, ctx())), /Rotor only/);

  const data = await load("settings-data");
  assert.match(text(data.render({ health: { status: { fast: "ok", bulk: "never" }, lanes: {}, alerts: [] }, backups: [] }, ctx())), /Pause everything/);

  const perms = await load("settings-permissions");
  const p = text(perms.render({ catalog: [{ key: "settings:owner", label: "Owner settings", group: "Settings", defaults: { owner: true, admin: false, tech: false }, owner_only: true }, { key: "contacts:read", label: "See contacts", group: "Contacts", defaults: { owner: true, admin: true, tech: "own" }, owner_only: false }], roles: {}, auth: { office_cookie_roles: ["owner"] } }));
  assert.match(p, /<option value="own" selected>Own<\/option>/);
  assert.match(p, /Owners<\/span>/);

  const autos = await load("automations");
  const au = text(autos.render({ paused: false, automations: [{ key: "x.y", label: "Fixture", available: true, settings: { enabled: true }, last7: { sent: 0, dry_run: 2 } }, { key: "lead.ack", label: "Thank a new lead by text", available: false, arrives_with: "Sales", when: "5 min", action: "Text" }] }, ctx()));
  assert.match(au, /2 in the outbox/);
  assert.match(au, /aria-checked="true"/);
  assert.match(au, /Sales/);

  const templates = await load("templates");
  assert.match(text(templates.render({ rows: [{ id: "tp_1", key: "visit_note", name: "Visit note", channel: "sms", category: "service", active: true, built_in: true }], channel: "" })), /#\/templates\/tp_1/);
  const template = await load("template");
  assert.match(text(template.render({ t: { id: "tp_1", key: "visit_note", name: "Visit note", channel: "sms", category: "service", body: "Hi {{first_name}}", built_in: true }, vars: [{ name: "first_name", label: "First name" }], contact: null })), /\{\{first_name\}\}/);

  const me = await load("me");
  const mm = text(me.render({ user: { id: "us_1", name: "Olive Owner", login: "olive", role: "owner", notify: { new_lead: ["push"] } }, sessions: [], push: { mode: "live", vapid_public: "BAAA", subscriptions: [{ hash: "a".repeat(64), ua: "iPhone", created_at: NOW }] }, keys: [{ id: "ak_1", name: "Claude", kind: "header", last4: "abcd", created_at: NOW }] }, ctx()));
  assert.match(mm, /Turn on for this phone/);
  assert.match(mm, /…abcd/);
  assert.match(mm, /New leads/);
});

test("M1.3 review: names instead of ids, the hours grid's Open column, rows that wrap", async () => {
  const activity = await load("activity");
  const a = text(activity.render({ date: "2026-11-17", user: "", type: "", labels: { tp_1: "Visit note" }, rows: [
    { at: NOW, type: "template", id: "tp_1", action: "update", actor: "us_00000000000000000002" },
    { at: NOW, type: "user", id: "us_00000000000000000001", action: "update", actor: "us_00000000000000000002" },
    { at: NOW, type: "cfg", id: "messaging", action: "update", actor: "us_00000000000000000002" },
    { at: NOW, type: "bulk_run", id: "bk_01m7aaaaaaaaaaaaaaaa", action: "create", actor: "system" },
  ], users: [{ id: "us_00000000000000000001", name: "Olive Owner", first_name: "Olive" }, { id: "us_00000000000000000002", name: "Ada Admin", first_name: "Ada" }] }, ctx(["audit:read", "schedule:read"])));
  assert.match(a, /Ada Admin changed template/);
  assert.match(a, /Visit note/);
  assert.match(a, /Olive Owner/);
  assert.match(a, /messaging settings/);
  const visible = (h) => h.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(visible(a), /us_0000|tp_1|bk_01m7/, "no raw ids on the screen");

  const outbox = await load("outbox");
  const o = text(outbox.render({ date: "2026-11-17", tab: "outbox", kind: "", items: [{ id: "ob_1", kind: "sms", mode: "dry_run", to_masked: "(763) •••-0101", contact_id: "ct_01m7aaaaaaaaaaaaaaaa", contact_label: "Pat Example", body: "Hi", created_at: NOW }], next: null, log: [] }, ctx()));
  assert.match(o, /Pat Example/);
  assert.doesNotMatch(visible(o), /ct_01m7/);

  const general = await load("settings-general");
  const doc = (data) => ({ name: "x", data, etag: '"1"' });
  const h = text(general.render({ section: "hours", hours: doc({ 0: null, 1: ["08:00", "18:00"] }), calendar: doc({ rules: [], dates: [] }), dates: [] }));
  assert.match(h, /<span class="gh">Open<\/span>/, "the checkbox column has a header");
  assert.match(h, /name="from_0"[^>]*disabled/, "a closed day's times are disabled (and styled as such)");

  const notes = await load("notifications");
  assert.match(text(notes.render({ items: [{ id: "nt_1", kind: "new_lead", title: "New lead: Pat in Delano", body: "x", link: "/today", read_at: null, created_at: NOW }] })), /class="nm two"/, "a long title wraps to two lines");

  const messaging = await load("settings-messaging");
  const m = text(messaging.render({ messaging: doc({ quiet: {}, footer: {} }), comms: doc({ reply_keywords: { enabled: false } }), test: { ...doc({ contact_id: "ct_01m7aaaaaaaaaaaaaaaa" }), labels: { contact_id: "Tess Tester" } }, words: [] }, ctx()));
  assert.match(m, /Tess Tester/);
  assert.doesNotMatch(visible(m), /ct_01m7/);
});
