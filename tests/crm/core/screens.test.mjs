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
  assert.match(td, /background work hasn't finished/);
  assert.match(td, /Notifications, 3 new/);
});

test("Settings screens, Automations, Templates and My account render for an owner", async () => {
  const settings = await load("settings");
  const hub = text(settings.render({ health: { status: { fast: "ok", bulk: "ok" }, lanes: {} } }, ctx()));
  // the hub: a short list of groups (the owner's "just make it more organized"), each opening its own page
  const groupRows = [...hub.matchAll(/data-group="([a-z]+)"[^>]*>.*?class="nm">([^<]+)<\/span><span class="sub">([^<]+)</g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&"), m[3]]);
  assert.deepEqual(groupRows.map(([k]) => k), ["business", "team", "services", "messages", "payments", "connections", "data", "phone"]);
  assert.deepEqual(groupRows.map(([, l]) => l), ["Business", "Team", "Services & pricing", "Messages", "Payments", "Connections", "Rotor & data", "This phone"]);
  assert.equal(groupRows[1][2], "Team, permissions, payroll", "a grey line naming what is inside");
  for (const [, , cap] of groupRows) assert.ok(cap.length <= 34, `one line on an iPhone SE: ${cap}`);
  assert.match(hub, /href="#\/settings\/g\/business" data-group="business"/, "a group opens its page");
  assert.match(hub, /href="#\/settings\/g\/payments" data-group="payments"/, "Payments now holds two rows (Client portal): its own page");
  assert.doesNotMatch(hub, /data-fold|set-sec/, "no folding: the groups replace it");
  assert.match(hub, /class="rs-label">About</);
  // the search list: every row once, hidden until something is typed, each with its group's name
  const res = hub.slice(hub.indexOf("set-res"), hub.indexOf("set-groups"));
  const links = [...res.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(links).size, links.length, "each setting in one place");
  for (const p of ["/settings/permissions", "/team", "/templates", "/automations", "/settings/cadences", "/settings/schedule", "/import", "/activity", "/tab-bar"]) assert.ok(links.includes(p), p);
  assert.match(res, /data-theme-row/, "Light or dark");
  assert.match(res, /<li data-label="discounts" data-in="services" data-grp="services &amp; pricing" hidden>/);
  const found = text(settings.render({ health: null, q: "disc" }, ctx()));
  assert.match(found, /<li data-label="discounts" data-in="services" data-grp="services &amp; pricing"><a class="row set-row" href="#\/settings\/discounts">.*?<span class="sub">Services &amp; pricing<\/span>/, "a result shows, with its group");
  assert.match(found, /class="set-groups" hidden/, "the groups step aside while searching");
  const office = text(settings.render({ health: null }, ctx(["settings:general"])));
  assert.doesNotMatch(office, /href="#\/settings\/permissions"/, "owner-only rows hidden from the office");
  assert.doesNotMatch(office, /data-group="team"/, "a group with nothing to open is hidden");

  const group = await load("settings-group");
  const S = await import("../../../crm-app/modules/system/settings.js");
  const page = text(group.render({ key: "services", group: S.group(() => true, "services") }));
  assert.equal(group.title({ group: S.group(() => true, "services") }), "Services & pricing");
  assert.deepEqual([...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]), ["/settings/pricing", "/settings/discounts", "/settings/estimate-templates", "/settings/plans", "/settings/agreement-templates", "/settings/checklists", "/settings/schedule"]);
  assert.match(page, /<ul class="list set-list" aria-label="Services &amp; pricing">/, "one inset card");
  assert.match(page, /Owner<\/span>/, "the owners' rows say so");
  assert.match(text(group.render({ key: "nope", group: null })), /Nothing in this group for your login/);
  assert.match(text(group.render({ key: "phone", group: S.group(() => true, "phone") })), /data-theme-row/);

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

test("Settings groups (pure): every LAYOUT row in exactly one group, nothing lost, each role sees what it may open", async () => {
  const S = await import("../../../crm-app/modules/system/settings.js");
  const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
  const { ROLE_DEFAULTS } = await import("../../../netlify/lib/crm/core/perms.mjs");
  const paths = S.LAYOUT.flatMap(([, , , , rows]) => rows.map(([p]) => p));
  assert.equal(new Set(paths).size, paths.length, "each row in one group");
  assert.deepEqual(S.LAYOUT.map(([k]) => k), ["business", "team", "services", "messages", "payments", "connections", "data", "phone"]);
  // the target hub's rows, by group
  const rows = Object.fromEntries(S.LAYOUT.map(([k, , , , r]) => [k, r.map(([, l]) => l)]));
  assert.deepEqual(rows.business, ["Company details", "Service area", "Hours & holidays", "Tracking link"]);
  assert.deepEqual(rows.team, ["Team", "Permissions", "Payroll & pay rates"]);
  assert.deepEqual(rows.services, ["Prices & price book", "Discounts", "Estimate templates", "Plans & perks", "Agreements", "Checklists", "Crew & forecast"]);
  assert.deepEqual(rows.messages, ["Message templates", "Automatic messages", "Follow-up cadences", "Quiet hours & opt-out", "Texting & email setup", "Business numbers", "Muted contacts", "Reviews", "Approvals", "Outbox (not sent)"]);
  assert.deepEqual(rows.payments, ["Payments & card fees", "Client portal"]);
  assert.deepEqual(rows.connections, ["Integrations", "Claude connector", "Where website leads go", "Facebook lead forms", "Maps & team map", "Door to door"]);
  assert.deepEqual(rows.data, ["Import from Rotor", "Switch from Rotor", "Data & backups", "Dashboard numbers", "Activity log", "Rotor's first customer list", "Open Rotor"]);
  assert.deepEqual(rows.phone, ["Light or dark", "Tab bar", "Calendar feed"]);
  // every module's settings entry is named (so none lands at a group's end by accident)
  assert.deepEqual(MANIFESTS.flatMap((m) => m.settings || []).filter((x) => !paths.includes(x.path)).map((x) => x.path), [], "every module's setting has its group");
  // every row is a screen some module registers (nothing points nowhere)
  const all = S.groups(() => true);
  const shown = all.flatMap((g) => g.items.map((x) => x.path));
  assert.deepEqual(shown.slice().sort(), paths.slice().sort(), "everyone-may: every row shows, in one group each");
  for (const g of all) assert.ok(g.caption && g.caption.length <= 34, `${g.key}: ${g.caption}`);

  // a module's entry LAYOUT doesn't name: its section's group (old keys too), else Business's end; never lost
  const extra = { name: "x", routes: [{ path: "/x/a" }, { path: "/x/b" }, { path: "/x/c" }, { path: "/x/d", perm: "settings:owner" }, { path: "/x/e" }], settings: [
    { label: "Old maps key", path: "/x/a", section: "maps" }, { label: "Old look key", path: "/x/b", section: "look" },
    { label: "No section", path: "/x/c" }, { label: "Owners only", path: "/x/d", perm: "settings:owner", section: "data" }, { label: "New key", path: "/x/e", section: "messages" }] };
  const withX = S.groups((p) => p !== "settings:owner", [...MANIFESTS, extra]);
  const where = (p) => (withX.find((g) => g.items.some((x) => x.path === p)) || {}).key;
  assert.equal(where("/x/a"), "connections");
  assert.equal(where("/x/b"), "phone");
  assert.equal(where("/x/c"), "business");
  assert.equal(where("/x/e"), "messages");
  assert.equal(where("/x/d"), undefined, "a row this person may not open is not shown");
  const biz = withX.find((g) => g.key === "business").items.map((x) => x.path);
  assert.equal(biz[biz.length - 1], "/x/c", "at the group's end");

  // the roles (the permission defaults, §4.5)
  const as = (role) => S.groups((p) => ROLE_DEFAULTS[role][p]);
  const keys = (gs) => gs.map((g) => g.key);
  const has = (gs, p) => gs.some((g) => g.items.some((x) => x.path === p));
  const owner = as("owner");
  assert.deepEqual(keys(owner), ["business", "team", "services", "messages", "payments", "connections", "data", "phone"], "the owner sees all eight");
  for (const p of ["/settings/permissions", "/settings/payroll", "/settings/payments", "/cutover", "/import", "/team"]) assert.ok(has(owner, p), p);
  assert.ok(owner.find((g) => g.key === "team").items.find((x) => x.path === "/settings/permissions").owner, "Owner badge");
  const admin = as("admin");
  assert.deepEqual(keys(admin), ["business", "services", "messages", "connections", "data", "phone"], "no Team or Payments for an admin");
  for (const p of ["/settings/permissions", "/settings/payroll", "/settings/payments", "/settings/pricing", "/cutover", "/import", "/team", "/settings/integrations"]) assert.ok(!has(admin, p), `admin: ${p}`);
  for (const p of ["/templates", "/settings/discounts", "/activity", "/settings/data", "/calendar-feed"]) assert.ok(has(admin, p), `admin: ${p}`);
  assert.ok(admin.every((g) => g.items.every((x) => !x.owner)), "no owner-only row for an admin");
  const tech = as("tech");
  assert.deepEqual(tech.map((g) => [g.key, g.items.map((x) => x.path)]), [["phone", ["#theme", "/tab-bar"]]], "a tech: only this phone (and the hub itself is not theirs)");
  assert.notEqual(ROLE_DEFAULTS.tech["settings:general"], true);
  assert.equal(S.group((p) => ROLE_DEFAULTS.tech[p], "team"), null);
  assert.equal(S.group(() => true, "nope"), null);
});
