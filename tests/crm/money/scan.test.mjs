// Scan to pay (money/scan.mjs; docs/CRM-MONEY.md "Scan to pay"): the pay
// code on the Invoice screen and on Collect payment is the customer's own
// pay link (one invoice, nothing more, the same lifetime as the text's),
// made fresh each time; the screen says why there's no code for a paid,
// void, written-off or Rotor-billed invoice; an open from the code and a
// payment that starts there say so on the invoice (via "qr"); who may show
// it. Payments stay dry run (the practice Checkout), for sandboxed
// customers only. Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, testContact, importedCustomer, bookedJob, openInvoice, invoiceOf, recs, scope, store, uuid, PJSON, IMPORT, PORTAL, advance } from "./fixtures.mjs";

const qr = await import("../../../crm-app/core/qr.js");
const SCAN = await import("../../../netlify/lib/crm/modules/money/scan.mjs");

const codeOf = (url) => url.split("/").pop();
async function openLink(t, url, extra = {}) {
  const r = await t.portal("/api/portal/open", { method: "POST", headers: { ...PJSON, ...extra }, body: { code: codeOf(url) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ck = t.setCookies(r).find((x) => x.startsWith("barta_portal="));
  return { location: r.body.data.location, cookie: ck ? ck.split(";")[0] : null };
}
const linkRecord = (t, url) => t.stores.data.json(PORTAL.linkKey(codeOf(url)));

test("scan to pay on the Invoice screen: a fresh pay link of that one invoice (the text's lifetime), the customer's first name, what's due; noted on the invoice; a second show is a new link", async () => {
  const { t, owner, admin } = await setup();
  try {
    const c = await testContact(owner, { first_name: "Terry" });
    const inv = await openInvoice(t, owner, c, { cents: 29500 });
    let one = await t.api(`/invoices/${inv.id}`, { as: admin });
    assert.equal(one.body.data.can.qr, true, "an open invoice has a pay code");
    const r = await t.api(`/invoices/${inv.id}/pay-qr`, { method: "POST", as: admin, body: {} });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.data;
    assert.match(d.url, /^https:\/\/www\.bartawindowwashing\.com\/p\/[0-9A-Za-z]{10}$/, "the same kind of link the invoice text carries");
    assert.deepEqual([d.number, d.balance_cents, d.first_name], [inv.number, 29500, "Terry"]);
    assert.ok(Object.keys(d).every((k) => ["url", "expires_at", "number", "balance_cents", "first_name"].includes(k)), "nothing more than the code needs");
    // the link: this invoice's scope only, kept as a hash, marked as the code's, the invoice text's lifetime
    const rec = linkRecord(t, d.url);
    assert.deepEqual(rec.scope, { kind: "invoice", id: inv.id });
    assert.equal(rec.created_by, `qr:${admin.id}`);
    assert.equal(rec.expires_at, d.expires_at);
    const textLink = await scope(async () => (await import("../../../netlify/lib/crm/modules/money/automations.mjs")).invoiceLink(inv, "test"));
    assert.equal(rec.expires_at, textLink.expires_at, "as long as the link in the invoice text");
    assert.equal(t.stores.data.keys("plk/").some((k) => k.includes(codeOf(d.url))), false, "the code itself is never stored");
    // it reads back from the QR the screen draws, and stays small enough to scan off a phone
    const q = qr.qrMatrix(d.url, { ecl: "M" });
    assert.ok(q.version <= 4);
    // noted on the invoice: shown once, by whom
    let x = await invoiceOf(inv.id);
    assert.equal(x.qr.shown, 1);
    assert.equal(x.qr.last_shown_by, admin.id);
    // shown again: a new link (links are never stored, so they can't be shown twice)
    const r2 = await t.api(`/invoices/${inv.id}/pay-qr`, { method: "POST", as: owner, body: {} });
    assert.notEqual(r2.body.data.url, d.url);
    x = await invoiceOf(inv.id);
    assert.deepEqual([x.qr.shown, x.qr.last_shown_by], [2, owner.id]);
    // the answer is never kept for a replay (a bearer link)
    assert.equal(t.stores.data.keys("idem/").length, 0);
    // the code opens that invoice and nothing else: not the hub, not another invoice, not the card page
    const other = await openInvoice(t, owner, c, { cents: 10000 });
    const { location, cookie } = await openLink(t, d.url);
    assert.equal(location, `/p/invoice/${inv.id}`);
    assert.equal((await t.portal(`/p/invoice/${inv.id}`, { cookie })).status, 200);
    for (const path of [`/p/invoice/${other.id}`, "/p/hub", "/p/card"]) assert.equal((await t.portal(path, { cookie })).status, 401, path);
  } finally { t.done(); }
});

test("no code to scan: a draft, a paid, voided or written-off invoice, Rotor's own, a customer Rotor bills, a card charge running; the screen says why", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const say = async (id) => { const r = await t.api(`/invoices/${id}/pay-qr`, { method: "POST", as: owner, body: {} }); return [r.status, r.body.error && r.body.error.message]; };
    const draft = await openInvoice(t, owner, c, { issue: false });
    assert.deepEqual(await say(draft.id), [409, "This invoice is a draft. Send it or issue it first."]);
    assert.equal((await t.api(`/invoices/${draft.id}`, { as: owner })).body.data.can.qr, false);
    const paid = await openInvoice(t, owner, c, { cents: 5000 });
    await t.api(`/invoices/${paid.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 5000, client_id: uuid(41) } });
    assert.deepEqual(await say(paid.id), [409, "This invoice is paid. Nothing to scan."]);
    assert.equal((await t.api(`/invoices/${paid.id}`, { as: owner })).body.data.can.qr, false);
    const voided = await openInvoice(t, owner, c, { cents: 5000 });
    await t.api(`/invoices/${voided.id}/void`, { method: "POST", as: owner, body: { reason: "Typed twice" } });
    assert.deepEqual(await say(voided.id), [409, "This invoice was voided. Nothing to scan."]);
    const off = await openInvoice(t, owner, c, { cents: 5000 });
    await t.api(`/invoices/${off.id}/write-off`, { method: "POST", as: owner, body: {} });
    assert.deepEqual(await say(off.id), [409, "This invoice was written off. Nothing to scan."]);
    // a customer Rotor still bills (typed in here, not a test contact): card payments wait for the switch
    const robin = await importedCustomer();
    const theirs = await openInvoice(t, owner, robin, { cents: 12000 });
    assert.deepEqual(await say(theirs.id), [409, "Rotor still bills this customer, so paying by card opens after the switch. Take cash or a check."]);
    // Rotor's own invoice (the import's)
    const rotorInv = await scope(async () => (await store.createRecord("invoice", {
      number: "INV-0598", seq: "imported", n: 598, kind: "standard", contact_id: robin.id, contact_name: "Robin Imported", status: "open", issued_on: "2026-11-14", due_on: "2026-11-14",
      lines: [{ id: "ln_1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: 21500, total_cents: 21500 }],
      import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "7".repeat(64) }, rotor: { status_raw: "sent", total_cents_raw: 21500 },
    }, IMPORT)).data);
    assert.deepEqual(await say(rotorInv.id), [409, "This invoice is still Rotor's until the switch, so it has no pay code here."]);
    assert.equal((await t.api(`/invoices/${rotorInv.id}`, { as: owner })).body.data.can.qr, false);
    // a card charge running right now
    const busy = await openInvoice(t, owner, c, { cents: 7000 });
    await scope(() => store.updateRecord("invoice", busy.id, (x) => ({ ...x, charging: { by: "test", until: new Date(Date.parse("2026-11-17T15:05:00Z")).toISOString(), attempt_id: "att1", n: 1 } }), { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" }));
    assert.deepEqual(await say(busy.id), [409, "A card charge is running on this invoice right now. Check again in a minute."]);
    // none of these made a link
    assert.equal(t.stores.data.keys("plk/").length, 0);
  } finally { t.done(); }
});

test("who may show it: the office from the Invoice screen; a tech only on Collect payment of their own visit, and only while it is theirs", async () => {
  const { t, owner, admin, tech, tech2 } = await setup();
  try {
    const c = await testContact(owner, { first_name: "Terry" });
    const inv = await openInvoice(t, owner, c);
    assert.equal((await t.api(`/invoices/${inv.id}/pay-qr`, { method: "POST", as: tech, body: {} })).status, 403, "the Invoice screen isn't a tech's");
    assert.equal((await t.api(`/invoices/${inv.id}/pay-qr`, { method: "POST", as: admin, body: {} })).status, 201);
    // Collect payment: the tech on the visit gets the code (with the customer's first name); the other tech doesn't
    const { visit } = await bookedJob(owner, c, { techs: [tech] });
    const mine = await t.api(`/visits/${visit.id}/pay-link`, { method: "POST", as: tech, body: {} });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.deepEqual([mine.body.data.first_name, mine.body.data.balance_cents], ["Terry", 29500]);
    assert.equal(linkRecord(t, mine.body.data.url).created_by, `qr:${tech.id}`);
    assert.equal((await t.api(`/visits/${visit.id}/pay-link`, { method: "POST", as: tech2, body: {} })).status, 404, "not their visit");
    // a visit outside the tech's window (a month ago) is no longer theirs to collect on
    const old = await bookedJob(owner, await testContact(owner), { techs: [tech], date: "2026-10-01" });
    assert.equal((await t.api(`/visits/${old.visit.id}/pay-link`, { method: "POST", as: tech, body: {} })).status, 404);
    // a customer Rotor still bills: the tech's screen says so instead of a code
    const robin = await importedCustomer();
    const rv = await bookedJob(owner, robin, { techs: [tech] });
    const refused = await t.api(`/visits/${rv.visit.id}/pay-link`, { method: "POST", as: tech, body: {} });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /Rotor still bills this customer/);
  } finally { t.done(); }
});

test("opened from the code: the pay page leads with Barta's name and what's due, the open goes on the invoice (once a couple of minutes), the payment says it came from the code; the text's link stays as it was", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner, { first_name: "Terry" });
    const inv = await openInvoice(t, owner, c, { cents: 29500 });
    const code = (await t.api(`/invoices/${inv.id}/pay-qr`, { method: "POST", as: owner, body: {} })).body.data;
    const { cookie } = await openLink(t, code.url);
    const page = await t.portal(`/p/invoice/${inv.id}`, { cookie });
    assert.equal(page.status, 200);
    const html = page.text;
    assert.match(html, /data-scan/);
    assert.ok(html.indexOf("data-scan") < html.indexOf("data-pay-btn") && html.indexOf("data-pay-btn") < html.indexOf('class="lines"'), "the amount, then Pay, then the details");
    assert.match(html, /<p class="who">Barta Window Washing<\/p>[\s\S]*for Terry[\s\S]*<p class="due-amt">\$295\.00<\/p>/);
    assert.match(html, /data-beacon-kind="invoice" data-beacon-id="in_/);
    assert.match(html, /name="viewport" content="width=device-width/);
    // the GET changed nothing; the beacon (after load) notes the open
    assert.equal((await invoiceOf(inv.id)).qr.opened, 0, "shown, not opened yet");
    const beacon = (ck) => t.portal("/api/portal/beacon", { method: "POST", headers: PJSON, cookie: ck, body: { kind: "invoice", id: inv.id } });
    assert.equal((await beacon(cookie)).status, 204);
    let x = await invoiceOf(inv.id);
    assert.equal(x.qr.opened, 1);
    assert.ok(x.qr.first_opened_at && x.qr.last_opened_at);
    await beacon(cookie);
    assert.equal((await invoiceOf(inv.id)).qr.opened, 1, "a reload is the same open");
    advance(3 * 60 * 1000);
    await beacon(cookie);
    assert.equal((await invoiceOf(inv.id)).qr.opened, 2);
    // a link preview bot's beacon counts nothing
    await t.portal("/api/portal/beacon", { method: "POST", headers: { ...PJSON, "user-agent": "facebookexternalhit/1.1" }, cookie, body: { kind: "invoice", id: inv.id } });
    assert.equal((await invoiceOf(inv.id)).qr.opened, 2);
    // the invoice text's own link: the page as it always was, no beacon, nothing noted
    const text = await scope(async () => (await import("../../../netlify/lib/crm/modules/money/automations.mjs")).invoiceLink(inv, "test"));
    const viaText = await openLink(t, text.url);
    const plain = await t.portal(`/p/invoice/${inv.id}`, { cookie: viaText.cookie });
    assert.doesNotMatch(plain.text, /data-scan|data-beacon-kind/);
    assert.ok(plain.text.indexOf('class="lines"') < plain.text.indexOf("data-pay-btn"), "details first, as before");
    assert.equal((await beacon(viaText.cookie)).status, 204);
    assert.equal((await invoiceOf(inv.id)).qr.opened, 2, "an open from the text isn't a scan");
    // pay from the code (practice Checkout: a test contact, dry run): the payment and the session say "qr"
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "15", via: "text" } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.match(co.body.data.url, /\/p\/dry-checkout\/dry_cs_/, "practice money: nothing reaches Stripe");
    assert.equal((await invoiceOf(inv.id)).checkout_sessions.slice(-1)[0].via, "qr", "the page's say-so is never taken: the session's link decides");
    await t.portal(`/api/portal/dry-checkout/${codeOf(co.body.data.url)}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    x = await invoiceOf(inv.id);
    assert.equal(x.status, "paid");
    const pay = recs(t, "payment").find((p) => p.invoice_id === inv.id);
    assert.deepEqual([pay.via, pay.simulated, pay.tip_cents], ["qr", true, 4425]);
    const row = (await scope(() => store.readIndex("payments", "2026-11"))).rows.find((r) => r.id === pay.id);
    assert.equal(row.vq, 1);
    // the invoice screen shows it: shown, opened, and the payment from the code
    const one = await t.api(`/invoices/${inv.id}`, { as: owner });
    assert.equal(one.body.data.invoice.qr.shown, 1);
    assert.equal(one.body.data.payments.find((p) => p.id === pay.id).via, "qr");
    // the page from the code after it's paid: the paid page, no door layout
    assert.doesNotMatch((await t.portal(`/p/invoice/${inv.id}`, { cookie })).text, /data-scan/);
    // a payment from the text's link says nothing about a code
    const inv2 = await openInvoice(t, owner, c, { cents: 10000 });
    const t2 = await scope(async () => (await import("../../../netlify/lib/crm/modules/money/automations.mjs")).invoiceLink(inv2, "test"));
    const o2 = await openLink(t, t2.url);
    const co2 = await t.portal(`/api/portal/invoices/${inv2.id}/checkout`, { method: "POST", headers: PJSON, cookie: o2.cookie, body: { tip_choice: "0", via: "qr" } });
    await t.portal(`/api/portal/dry-checkout/${codeOf(co2.body.data.url)}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(recs(t, "payment").find((p) => p.invoice_id === inv2.id).via, undefined);
  } finally { t.done(); }
});

test("a phone already holding the customer's account page: the code opens beside it and still counts as a scan; an expired code says so", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const hub = await scope(() => PORTAL.createPortalLink({ contact_id: c.id, scope: { kind: "hub" } }));
    const h = await openLink(t, hub.url);
    const code = (await t.api(`/invoices/${inv.id}/pay-qr`, { method: "POST", as: owner, body: {} })).body.data;
    const again = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, cookie: h.cookie, body: { code: codeOf(code.url) } });
    assert.equal(again.status, 200);
    assert.equal(t.setCookies(again).length, 0, "the account page's session keeps going, with this invoice granted");
    assert.match((await t.portal(`/p/invoice/${inv.id}`, { cookie: h.cookie })).text, /data-scan/);
    assert.equal(await scope(async () => SCAN.viaQr((await PORTAL.portalSession(new Request("https://www.bartawindowwashing.com/", { headers: { cookie: h.cookie } }))), inv.id)), true);
    // the code runs out with the invoice text's lifetime: then the page says so
    advance(400 * 24 * 3600 * 1000);
    const late = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: codeOf(code.url) } });
    assert.equal(late.status, 410);
    assert.match(late.body.error.message, /That link has expired/);
  } finally { t.done(); }
});

test("the staff screens: Show QR to pay on an open invoice, the code full screen with the amount, the first name and the words to scan, the reason instead of a code, the history", async () => {
  const inv = await import("../../../crm-app/modules/money/invoice.js");
  const P = await import("../../../crm-app/modules/money/pay-qr.js");
  const ctx = { can: () => true, user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, params: {} };
  const IN = "in_00000000000000000001", CT = "ct_00000000000000000001";
  const XSS = "</script><script>alert(1)</script>";
  const base = {
    invoice: { id: IN, number: "SINV-0007", kind: "standard", status: "open", contact_id: CT, lines: [], total_cents: 29500, balance_cents: 29500, paid_cents: 0, refunded_cents: 0, issued_on: "2026-11-10",
      qr: { shown: 2, last_shown_at: "2026-11-17T15:05:00.000Z", last_shown_by: "us_00000000000000000001", opened: 1, first_opened_at: "2026-11-17T15:06:00.000Z", last_opened_at: "2026-11-17T15:06:00.000Z" } },
    flags: {}, payments: [{ id: "pm_00000000000000000001", kind: "payment", method: "card", status: "succeeded", total_cents: 29500, tip_cents: 0, received_on: "2026-11-17", via: "qr", card: { last4: "4242" } }],
    contact: { id: CT, display_name: "Terry Sample" }, card: { status: "none" }, can: { qr: true, send: true, record: true }, online: "ok", system_of_record: "rotor",
  };
  const out = String(inv.default.render(base, ctx));
  assert.match(out, /data-act="qr"[^>]*>[\s\S]*Show QR to pay/);
  assert.match(out, /Pay code shown<\/dt><dd>2 times, the last/);
  assert.match(out, /Opened from the code<\/dt><dd>/);
  assert.match(out, /scanned the pay code/);
  assert.doesNotMatch(String(inv.default.render({ ...base, can: { send: true } }, ctx)), /data-act="qr"/, "no button without the right (or on a closed invoice)");
  const code = String(P.codeView({ url: "https://www.bartawindowwashing.com/p/Zk3mQ9x7Lw", number: "SINV-0007", balance_cents: 29500, first_name: `Terry ${XSS}`, expires_at: "2027-04-15T04:59:00.000Z" }, { save: true }));
  assert.match(code, /<p class="mn-scan-amt">\$295\.00<\/p>/);
  assert.match(code, /Terry &lt;\/script&gt;/);
  assert.doesNotMatch(code, /<script>/);
  assert.match(code, /Scan with your phone camera to pay/);
  assert.match(code, /<svg [^>]*viewBox="0 0 41 41"/, "a version 4 code with its quiet zone");
  assert.match(code, /data-qr-png[\s\S]*data-qr-svg/);
  assert.match(code, /works until Apr 1[45], 2027/);
  assert.match(String(P.refusedView("This invoice is paid. Nothing to scan.")), /No code to scan[\s\S]*This invoice is paid\. Nothing to scan\.[\s\S]*data-qr-close/);
  // the picture for a printed invoice: the code, the amount and number, the words to scan
  const pic = P.printSvg({ url: "https://www.bartawindowwashing.com/p/Zk3mQ9x7Lw", number: "SINV-0007", balance_cents: 29500, first_name: "Terry", expires_at: "2027-04-15T04:59:00.000Z" });
  assert.match(pic, /^<svg [^>]*viewBox="0 0 1200 1560"/);
  assert.match(pic, />\$295\.00 · SINV-0007 · Terry<\/text>[\s\S]*>Scan with your phone camera to pay<\/text>/);
});
