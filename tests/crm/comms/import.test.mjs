// Comms: the Rotor import (design §10.2 rows 16, 32, 33, 35; §5.7.1
// "Imported conversations"; §11.4 M6 import.test). Synthetic exports only
// (tests/crm/fixtures/rotor-synthetic.mjs plus rows made here: made-up
// names, 555 numbers, example.com addresses).
//
//   - Rotor's messages become threads: one conversation per contact and
//     channel, each message written once, the HTML of an email sanitized
//     and its text extracted; no ib/ base and no pointer per message;
//   - the read/done rule: open and unread only when the last message is
//     inbound, under 14 days old and unanswered;
//   - an unchanged export writes nothing; a delta touches only its thread;
//   - templates: Barta's 26 under their own keys (never over a CRM
//     template), STOP text stripped, the two HTML emails as HTML, the
//     referral one inactive; campaigns as "sent"; pin types kept;
//   - attachments are the files the upload stored; a missing one is counted;
//   - the full-size run (CRM_IMPORT_FULL=1: 10,927 messages) stays inside
//     the bulk lane's steps and its storage calls are counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, generate, stageRun, runToEnd, importExport, store, staging, ids, runner, IMPORT } from "../import/fixtures.mjs";

const IR = await import("../../../netlify/lib/crm/modules/comms/import-rotor.mjs");
const CV = await import("../../../netlify/lib/crm/modules/comms/conversations.mjs");
const { getTemplateByKey } = await import("../../../netlify/lib/crm/core/templates.mjs");
const FULL = process.env.CRM_IMPORT_FULL === "1";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
const NOW = "2026-11-17T15:00:00Z";
const ago = (days, min = 0) => new Date(Date.parse(NOW) - days * 86400000 + min * 60000).toISOString().replace("Z", "+00:00");

let n = 0;
const msg = (c, o = {}) => ({
  id: `m6-msg-${String(++n).padStart(4, "0")}`, contact_ref_id: 1, contact_id: c.id, contact_type: "customer", channel: "sms", direction: "outbound", content: "See you Wednesday.", subject: null,
  status: "delivered", read: true, thread_id: `thread-${n}`, attachments: [], contact_email: null, contact_phone: c.phone, created_at: ago(30), ...o,
});
const HTML = `<!DOCTYPE html><html><head><title>Quote</title><style>.x{color:red}</style><script>alert(1)</script></head><body><table><tr><td style="color:#16161b">Hi Pat,</td></tr><tr><td>Your quote is ready.</td></tr></table><p><a href="http://example.com/q/1" onclick="x()">View Quote</a></p><img src="https://example.com/logo.png"></body></html>`;
// an export with no synthetic messages, templates or campaigns: the tests add their own
const base = (scale = 0.02) => { const ex = generate({ scale, seed: 21 }); ex.messages = []; ex.message_templates = []; ex.campaigns = []; return ex; };
const convOf = async (c, channel = "sms") => {
  const cid = (await store.readPointer("rotor/customer", c.id)).id;
  return (await store.getRecord("conversation", CV.convIdFor(cid, channel))) || null;
};
// Runs fn with the message phase's first and last storage call noted in span ({ start, end }).
async function spanned(S, span, fn) {
  const phase = IR.phases.find((p) => p.name === "comms.messages");
  const saved = { prepare: phase.prepare, finish: phase.finish };
  phase.prepare = async (rows, ctx) => { span.start ??= S.calls.length; return saved.prepare(rows, ctx); };
  phase.finish = async () => { span.end = S.calls.length; };
  try { return await fn(); } finally { phase.prepare = saved.prepare; phase.finish = saved.finish; }
}
const writesTo = (calls, re) => calls.filter((c) => ["set", "setJSON", "delete"].includes(c.op) && re.test(c.key || ""));

test("messages become threads: one conversation per contact and channel, messages written once, emails sanitized", async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = base();
    const [a, b] = ex.customers.filter((c) => c.phone && c.email);
    ex.messages = [
      msg(a, { content: "Hi Pat! Thanks for reaching out to BARTA Window Washing. When would be a good time for a quick call? Reply stop to opt-out.", thread_id: "surge-x-1", created_at: ago(40) }),
      msg(a, { direction: "inbound", status: "received", content: "Tomorrow afternoon", thread_id: "uuid-1", created_at: ago(40, 5) }),
      msg(a, { content: "REMINDER: Hi Pat, BARTA Window Washing is scheduled to visit on Nov 19 at 8:00 AM.", created_at: ago(39) }),
      msg(a, { channel: "email", content: HTML, subject: "Your quote from BARTA Window Washing", contact_phone: null, contact_email: a.email, status: "sent", created_at: ago(38) }),
      msg(b, { content: "Running about 15 minutes behind, see you soon!", status: "failed", created_at: ago(20) }),
    ];
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const S = t.stores.data;
    assert.equal(S.keys("rec/message/").length, 5);
    assert.equal(S.keys("rec/conversation/").length, 3, "a: sms + email, b: sms");
    assert.equal(S.keys("rel/conv-messages/").length, 5, "one thread row per message");
    assert.equal(S.keys("ib/message/").length, 0, "no import base per message (written once)");
    assert.equal(S.keys("ptr/rotor/message/").length, 0, "no pointer per message (the id is idForRotor)");
    assert.ok(S.keys("rec/message/").every((k) => S.json(k).created_by === "import" && S.json(k).provider === "rotor_import"));

    const sms = (await convOf(a)).data;
    assert.equal(sms.count, 3);
    assert.equal(sms.channel, "sms");
    assert.equal(sms.address, a.phone);
    assert.equal(sms.last_direction, "out");
    assert.match(sms.last_preview, /^REMINDER/);
    assert.deepEqual([sms.state, sms.unread, sms.needs_reply], ["done", 0, false]);
    assert.deepEqual(sms.rotor.thread_ids.sort(), ["surge-x-1", "uuid-1", `thread-${n - 2}`].sort(), "Rotor's three thread formats, one conversation");
    const page = await scope(() => CV.threadPage(sms.id));
    assert.deepEqual(page.items.map((m) => m.direction), ["out", "in", "out"], "newest first");
    const first = S.json(`rec/message/${ids.idForRotor("message", ex.messages[0].id)}`);
    assert.deepEqual(first.origin, { kind: "automation", id: "lead.ack" }, "Rotor's new-lead text");
    assert.equal(first.rotor.msg_class, "lead_ack");
    assert.equal(first.created_at, new Date(ex.messages[0].created_at).toISOString(), "Rotor's time kept");
    assert.equal(S.json(`rec/message/${ids.idForRotor("message", ex.messages[2].id)}`).rotor.msg_class, "reminder");
    assert.equal(S.json(`rec/message/${ids.idForRotor("message", ex.messages[1].id)}`).direction, "in");
    assert.equal(S.json(`rec/message/${ids.idForRotor("message", ex.messages[4].id)}`).status, "failed");

    const email = S.json(`rec/message/${ids.idForRotor("message", ex.messages[3].id)}`);
    assert.equal(email.channel, "email");
    assert.equal(email.subject, "Your quote from BARTA Window Washing");
    assert.match(email.body_text, /Hi Pat,[\s\S]*Your quote is ready\.[\s\S]*View Quote \(https:\/\/example\.com\/q\/1\)/);
    assert.ok(!/alert|color:red|<|onclick/.test(email.body_text), "no markup, script or style in the text");
    assert.ok(email.body_html && !/script|<style|onclick|logo\.png|<head|<title/i.test(email.body_html), "the HTML is sanitized (no script, style, handlers or outside images)");
    assert.match(email.body_html, /href="https:\/\/example\.com\/q\/1"/, "links forced to https");
    assert.equal((await convOf(a, "email")).data.last_preview, "Your quote from BARTA Window Washing");

    // the inbox lists them, the contact's stats know the first text and the last contact
    const inbox = await scope(() => CV.listInbox({}));
    assert.equal(inbox.items.length, 3);
    assert.deepEqual(S.keys("ix/inbox"), ["ix/inbox/y2026"], "handled threads sit in their year's shard");
    const stats = S.json(`rec/contact_stats/${sms.contact_id}`).comms;
    assert.equal(stats.first_sms["+17633143400"], new Date(ex.messages[0].created_at).toISOString());
    assert.equal(stats.last_inbound_at, new Date(ex.messages[1].created_at).toISOString());
    assert.equal(S.keys(`rel/contact-activity/${sms.contact_id}/`).filter((k) => /--(sms|email)\.history--/.test(k)).length, 2, "one timeline row per imported thread");
    assert.equal(S.keys(`rel/contact-convs/${sms.contact_id}/`).length, 2);
  } finally { t.done(); }
});

test("the read/done rule: open and unread only when the last message is inbound, under 14 days old and unanswered", async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = base();
    const [a, b, c, d] = ex.customers.filter((x) => x.phone);
    ex.messages = [
      msg(a, { created_at: ago(5) }), msg(a, { direction: "inbound", status: "received", read: false, content: "Can we move it to Thursday?", created_at: ago(3) }), msg(a, { direction: "inbound", status: "received", read: false, content: "Afternoon is best", created_at: ago(3, 2) }),
      msg(b, { direction: "inbound", status: "received", content: "Thanks!", created_at: ago(20) }),
      msg(c, { direction: "inbound", status: "received", content: "How much for screens?", created_at: ago(2) }), msg(c, { content: "Screens are $5 each.", created_at: ago(1) }),
      msg(d, { direction: "inbound", status: "received", content: "Yes please", created_at: ago(13, 60) }),
    ];
    await importExport(t, owner, ex);
    const A = (await convOf(a)).data, B = (await convOf(b)).data, C = (await convOf(c)).data, D = (await convOf(d)).data;
    assert.deepEqual([A.state, A.needs_reply, A.unread], ["open", true, 2], "inbound 3 days ago, unanswered: open, the two trailing texts unread");
    assert.deepEqual([B.state, B.needs_reply, B.unread], ["done", false, 0], "inbound 20 days ago: handled");
    assert.deepEqual([C.state, C.needs_reply, C.unread], ["done", false, 0], "answered: handled");
    assert.deepEqual([D.state, D.needs_reply, D.unread], ["open", true, 1], "just inside 14 days");
    assert.deepEqual(t.stores.data.keys("ix/inbox").sort(), ["ix/inbox/open", "ix/inbox/y2026"]);
    assert.equal(await scope(() => CV.unreadCount()), 2);
    const open = await scope(() => CV.listInbox({ filter: "needs_reply" }));
    assert.deepEqual(open.items.map((x) => x.id).sort(), [A.id, D.id].sort());
  } finally { t.done(); }
});

test("an unchanged export writes nothing; a delta touches only its own thread", async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = generate({ scale: 0.03, seed: 5 });
    const a = ex.customers.find((x) => x.phone && !ex.messages.some((m) => m.contact_id === x.id)) || ex.customers.find((x) => x.phone);
    const open = [msg(a, { status: "sent", created_at: ago(4) }), msg(a, { direction: "inbound", status: "received", read: false, content: "Can you come Friday instead?", created_at: ago(2) })];
    ex.messages.push(...open);
    await importExport(t, owner, ex);
    const S = t.stores.data;
    const FAM = /^(rec\/(message|conversation|template|campaign|contact_stats)\/|rel\/(conv-messages|contact-convs|contact-activity)\/|ix\/(inbox|campaigns|templates)|ib\/(conversation|template|campaign)\/|cfg\/pin_types)/;
    const snap = () => JSON.stringify(S.keys("").filter((k) => FAM.test(k)).sort().map((k) => [k, S.json(k)]));
    const before = snap();
    const total = S.keys("rec/message/").length;
    assert.equal(total, ex.messages.length);

    let mark = S.calls.length;
    const span = {};
    const again = await spanned(S, span, () => importExport(t, owner, ex));
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.conflicted, 0);
    assert.deepEqual(writesTo(S.calls.slice(mark), FAM), [], "no write to a message, a conversation, a thread row, a template, a campaign or the inbox");
    assert.equal(snap(), before, "byte-identical");
    const convs = S.keys("rec/conversation/").length;
    const inPhase = S.calls.slice(span.start, span.end);
    assert.equal(inPhase.filter((c) => /^rec\/message\//.test(c.key || "")).length, 0, "the phase reads no message on a re-run");
    const reads = inPhase.filter((c) => /^rec\/conversation\//.test(c.key || "")).length;
    assert.ok(reads <= convs * 1.2 + 2, `about one read per conversation (${reads} for ${convs}; a merged contact costs one more)`);

    // the delta: Rotor's "sent" became "delivered", and the office answered in Rotor
    const ex2 = JSON.parse(JSON.stringify(ex));
    ex2.messages.find((m) => m.id === open[0].id).status = "delivered";
    const reply = msg(a, { content: "Friday works. See you then!", created_at: ago(0, -60) });
    ex2.messages.unshift(reply);                 // Rotor lists newest first
    mark = S.calls.length;
    const delta = await importExport(t, owner, ex2);
    assert.equal(delta.run.status, "done");
    const made = writesTo(S.calls.slice(mark), /^rec\/message\//).map((c) => c.key);
    assert.deepEqual([...new Set(made)].sort(), [`rec/message/${ids.idForRotor("message", reply.id)}`, `rec/message/${ids.idForRotor("message", open[0].id)}`].sort(), "only the new message and the one whose status moved");
    assert.equal(S.keys("rec/message/").length, total + 1);
    assert.equal(S.json(`rec/message/${ids.idForRotor("message", open[0].id)}`).status, "delivered");
    const conv = (await convOf(a)).data;
    assert.deepEqual([conv.state, conv.needs_reply, conv.unread, conv.last_direction, conv.count], ["done", false, 0, "out", ex2.messages.filter((m) => m.contact_id === a.id && m.channel === "sms").length], "answered in Rotor: no longer waiting");
    assert.equal(conv.last_preview, "Friday works. See you then!");
    assert.ok(!S.keys("ix/inbox/open").length || !(S.json("ix/inbox/open").rows[conv.id] || {}).conversation?.d, "left the open shard");

    // a status never moves back (an older export after a newer one)
    await importExport(t, owner, ex);
    assert.equal(S.json(`rec/message/${ids.idForRotor("message", open[0].id)}`).status, "delivered");
    assert.equal(S.keys("rec/message/").length, total + 1, "a message missing from an export is never deleted");
  } finally { t.done(); }
});

test("a message whose contact the export lacks lands on a placeholder contact", async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = base();
    const ghost = { id: "00000000-0000-4000-8000-00000000dead", phone: "+17635550142" };
    ex.messages = [msg(ghost, { contact_type: "lead" }), msg(ghost, { contact_type: "lead", direction: "inbound", status: "received", content: "ok", created_at: ago(29) })];
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const cid = (await store.readPointer("rotor/lead", ghost.id)).id;
    assert.equal(cid, ids.idForRotor("contact", ghost.id));
    const c = t.stores.data.json(`rec/contact/${cid}`);
    assert.equal(c.flags.placeholder, true);
    assert.equal(c.lifecycle, "archived");
    const conv = t.stores.data.json(`rec/conversation/${CV.convIdFor(cid, "sms")}`);
    assert.equal(conv.count, 2);
    assert.equal(conv.state, "done", "an old inbound on a placeholder is handled");
  } finally { t.done(); }
});

test("templates: Barta's own under their own keys, STOP text stripped, the HTML emails as HTML, the referral one inactive, never over a CRM template", async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = base();
    const tpl = (o) => ({ id: `m6-tpl-${++n}`, name: "Template", type: "sms", subject: null, content: "Hi {first_name}!", tags: [], attachments: [], is_example: false, created_at: ago(60), updated_at: ago(50), ...o });
    const delano = `<!DOCTYPE html><html><head><style>h1{color:#0E1B2C}</style></head><body><h1>Thank you, Delano!</h1><img src="https://raw.githubusercontent.com/example/website/main/IMG_4788.jpeg"><p>We were voted Best of Delano Area 2026.</p><a href="https://www.bartawindowwashing.com/get-quote.html">Get your free quote</a><script>x()</script></body></html>`;
    ex.message_templates = [
      tpl({ name: "Review 1 - Same day (town + service)", content: "Hey {{first_name}}, Alex with Barta Window Washing here. Thanks for having us out today!\n\nhttps://g.page/r/CfnTsPliwEw4EBM/review", tags: ["review"] }),
      tpl({ name: "Review - Personal (Alex)", content: "Hey {{first_name}}, this is Alex with Barta Window Washing!", tags: ["review"] }),
      tpl({ name: "Giveaway 4 - 24h follow-up", content: "Hi {{first_name}}, your $250 off Christmas lights from Barta is still waiting. Reply YES and we'll get your quote over. Reply STOP to opt out.", tags: ["giveaway"] }),
      tpl({ name: "Fall PROMO", content: "Hey {first_name}! It's Jacob with BARTA Window Washing! Reply WINDOWS or LIGHTS. Reply stop to opt-out." }),
      tpl({ name: "Best of Delano 2026 Thank You", type: "email", subject: "Thank you, Delano! We were voted Best of Delano 2026", content: delano }),
      tpl({ name: "Referral Program Email", type: "email", subject: "Email", content: "<html><body><h1>Give $25. Get $50.</h1><p>Hi there,</p><a href=\"mailto:office@bartawindowwashing.com?subject=Unsubscribe\">Unsubscribe</a></body></html>" }),
      tpl({ name: "Job On My Way (Default)", content: "Hi {first_name}, our technician from {your_company_name} is on the way.", is_example: true, tags: ["default-template"] }),
    ];
    ex.campaigns = [{ id: 596, name: "Review Request - Last 30 Days (Oct 24)", description: "Personal review ask to 59 customers with jobs Sep 24 - Oct 23 and no Google review yet.", status: "inactive", messaging_template_id: ex.message_templates[1].id, sms_provider: { name: "surge", number: "+17633143400" }, created_at: ago(24), updated_at: "2026-10-24T15:00:00.000000" }];
    // a CRM template the office already has (and edited) under the key the review sequence uses
    const mine = await store.createRecord("template", { key: "review_1", name: "Review 1", channel: "sms", category: "service", body: "Our own wording, {{first_name|there}}.", tags: [], active: true, built_in: true }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "test" });
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const S = t.stores.data;
    const all = S.keys("rec/template/").map((k) => S.json(k));
    const imported = all.filter((x) => x.rotor);
    assert.equal(imported.length, 6, "Barta's six; Rotor's example is skipped");
    assert.ok(imported.every((x) => /^rotor_[a-z0-9_]+$/.test(x.key) && x.key.length <= 40 && x.built_in === false && x.tags.includes("rotor")));
    assert.equal(S.json(`rec/template/${mine.data.id}`).body, "Our own wording, {{first_name|there}}.", "the CRM's own template is untouched");
    assert.equal((await scope(() => getTemplateByKey("review_1"))).id, mine.data.id);
    const by = (name) => imported.find((x) => x.name === name);
    assert.equal(by("Review 1 - Same day (town + service)").category, "service");
    assert.equal(by("Review - Personal (Alex)").category, "marketing");
    const g = by("Giveaway 4 - 24h follow-up");
    assert.ok(!/stop/i.test(g.body) && /get your quote over\.$/.test(g.body), "the typed STOP line is gone (the sender adds the footer)");
    assert.deepEqual([g.active, g.tags.includes("archived")], [false, true], "giveaway templates arrive archived");
    const f = by("Fall PROMO");
    assert.match(f.body, /^Hey \{\{first_name\}\}!/, "{first_name} → {{first_name}}");
    assert.ok(!/opt-out/i.test(f.body));
    assert.deepEqual(f.variables, ["first_name"]);
    const d = by("Best of Delano 2026 Thank You");
    assert.equal(d.channel, "email");
    assert.ok(d.body_html && /<h1>Thank you, Delano!<\/h1>/.test(d.body_html), "kept as HTML");
    assert.match(d.body_html, /src="https:\/\/www\.bartawindowwashing\.com\/IMG_4788\.jpeg"/, "the hot-linked image is the site's own copy now");
    assert.ok(!/script|<style|githubusercontent/.test(d.body_html));
    assert.match(d.body, /Thank you, Delano!/, "its text part is made from the HTML");
    assert.equal(d.active, true);
    const ref = by("Referral Program Email");
    assert.ok(ref.body_html && ref.active === false, "the retired referral email arrives inactive");
    const rep = (await t.api(`/import/runs/${r.ir.id}/report`, { as: owner })).body.data;
    const w = rep.phases.find((p) => p.name === "comms.templates").warnings;
    assert.equal(w.template_stop_text_stripped, 2, "the report lists the templates whose STOP text was stripped");
    assert.equal(w.template_rotor_example_skipped, 1);

    const cm = S.keys("rec/campaign/").map((k) => S.json(k));
    assert.equal(cm.length, 1);
    assert.deepEqual([cm[0].status, cm[0].channel, cm[0].template_key, cm[0].rotor.campaign_id, cm[0].rotor.number], ["sent", "sms", by("Review - Personal (Alex)").key, 596, "+17633143400"]);
    assert.match(cm[0].description, /59 customers/);
    assert.equal(cm[0].rotor.updated_at, "2026-10-24T15:00:00.000Z", "a time without an offset is UTC");

    // the office edits an imported template; the next import keeps the edit and overwrites nothing
    const gid = g.id;
    await store.updateRecord("template", gid, (x) => ({ ...x, body: "Edited in the CRM, {{first_name|there}}.", active: true }), { by: owner.id, origin: "api", actor_kind: "user", requestId: "test" });
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.summary.conflicts_open, 0);
    const kept = S.json(`rec/template/${gid}`);
    assert.deepEqual([kept.body, kept.active], ["Edited in the CRM, {{first_name|there}}.", true]);
    assert.equal(S.keys("rec/template/").length, all.length, "no second copy");
    // pin types (row 35) are kept as a setting
    assert.deepEqual(S.json("cfg/pin_types").types.map((p) => p.label).slice(0, 2), ["No Answer", "Not Interested"]);
  } finally { t.done(); }
});

test("attachments are the files the upload stored (HTML ones download-only); one that wasn't uploaded is counted", async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = base();
    const a = ex.customers.find((x) => x.phone);
    const url = (k) => `https://example.com/storage/v1/object/public/attachments/x/${k}`;
    ex.messages = [
      msg(a, { direction: "inbound", status: "received", content: "Here are the photos", attachments: [{ url: url("one.jpg"), name: "one.jpg", type: "image/jpeg" }, { url: url("two.html"), name: "two.html", type: "text/html" }] }),
      msg(a, { direction: "inbound", status: "received", content: "One more", attachments: [{ url: url("lost.jpg"), name: "lost.jpg", type: "image/jpeg" }] }),
    ];
    const { ir } = await stageRun(t, owner, ex);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...Array(64).fill(7)]);
    await scope(() => staging.receiveMedia(ir, sha(url("one.jpg")), jpeg, { ref: `message_attachment:${ex.messages[0].id}`, ctx: IMPORT }));
    await scope(() => staging.receiveMedia(ir, sha(url("two.html")), Buffer.from("<!doctype html><html><body>hi</body></html>"), { ref: `message_attachment:${ex.messages[0].id}`, ctx: IMPORT }));
    const r = await runToEnd(t, owner, ir.id);
    assert.equal(r.run.status, "done");
    const S = t.stores.data;
    const m1 = S.json(`rec/message/${ids.idForRotor("message", ex.messages[0].id)}`);
    assert.equal(m1.attachment_file_ids.length, 2);
    const f1 = S.json(`rec/file/${m1.attachment_file_ids[0]}`), f2 = S.json(`rec/file/${m1.attachment_file_ids[1]}`);
    assert.deepEqual(f1.owner, { type: "message", id: m1.id }, "the file belongs to its message now");
    assert.equal(f1.contact_id, m1.contact_id);
    assert.equal(f2.download_only, true, "HTML media is stored download-only");
    const m2 = S.json(`rec/message/${ids.idForRotor("message", ex.messages[1].id)}`);
    assert.deepEqual([m2.attachment_file_ids.length, m2.rotor.attachments_missing], [0, 1]);
    // the office opens the photo; a tech with no visit there does not
    const tech = await t.user("tech");
    assert.equal((await t.api(`/files/${f1.id}`, { as: owner })).status, 200);
    assert.ok([403, 404].includes((await t.api(`/files/${f1.id}`, { as: tech })).status));
  } finally { t.done(); }
});

test(`the size of it (scale ${FULL ? 1 : 0.1}): the message phase stays inside the bulk lane's steps; its storage calls are counted`, async () => {
  const { t, owner } = await setup({ now: NOW });
  try {
    const ex = generate({ scale: FULL ? 1 : 0.1, seed: 7 });
    const S = t.stores.data;
    const span = {};
    const t0 = Date.now();
    // the live site makes about 20 storage calls a second: a 95-second step gets through about 450 message rows
    runner.IMPORT_LIMITS.stepRows = 450;
    const r = await spanned(S, span, () => importExport(t, owner, ex, { per: 900, maxPasses: 2000 }));
    runner.IMPORT_LIMITS.stepRows = Infinity;
    const ms = Date.now() - t0;
    assert.equal(r.run.status, "done");
    assert.ok(r.passes >= Math.floor(ex.messages.length / 450), `${r.passes} checkpointed steps`);
    assert.equal(S.keys("rec/message/").length, ex.messages.length, "every message");
    assert.equal(S.calls.filter((c) => c.op === "setJSON" && /^rec\/message\//.test(c.key)).length, ex.messages.length, "each written exactly once, whatever the step boundaries");
    assert.equal(S.keys("rel/conv-messages/").length, ex.messages.length);
    const convs = S.keys("rec/conversation/").length;
    const calls = span.end - span.start;
    const per = calls / ex.messages.length;
    assert.ok(per < 6, `${per.toFixed(2)} storage calls per message`);
    if (process.env.CRM_IMPORT_BREAKDOWN) { const by = {}; for (const c of S.calls.slice(span.start, span.end)) { const k = `${c.op} ${String(c.key || "").split("/").slice(0, 2).join("/").replace(/ir_[0-9a-z]+/, "RUN")}`; by[k] = (by[k] || 0) + 1; } process.stdout.write("# " + JSON.stringify(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 24)) + "\n"); }
    // no blob grows with the history: the biggest inbox shard and the biggest message stay small
    const shard = Math.max(...S.keys("ix/inbox").map((k) => JSON.stringify(S.json(k)).length));
    const biggest = Math.max(...S.keys("rec/message/").map((k) => JSON.stringify(S.json(k)).length));
    assert.ok(shard < 700000, `the biggest inbox shard is ${shard} bytes`);
    assert.ok(biggest < 60000, `the biggest message record is ${biggest} bytes`);

    const span2 = {};
    const again = await spanned(S, span2, () => importExport(t, owner, ex, { per: 900, maxPasses: 2000 }));
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    const recalls = span2.end - span2.start;
    assert.ok(recalls < convs * 3 + 300, `a re-run costs ${recalls} calls for ${convs} conversations`);
    process.stdout.write(`# comms import at scale ${FULL ? 1 : 0.1}: ${ex.messages.length} messages, ${convs} conversations, ${calls} storage calls (${per.toFixed(2)} per message; about ${Math.round(calls / 20 / 60)} min at 20 calls/s), ${r.passes} bulk passes, ${ms} ms in memory; unchanged re-run ${recalls} calls (about ${Math.round(recalls / 20)} s); biggest inbox shard ${shard} bytes, biggest message ${biggest} bytes\n`);
  } finally { t.done(); }
});
