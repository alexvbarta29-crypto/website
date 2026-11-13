// The money screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation escaped, links stay in the CRM, each
// screen offers only what the invoice's state and the login allow, and the
// QR code for a pay link is a real one. The phone walk
// (tests/e2e/money.spec.mjs) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/money/${name}.js`)).default;
const M = (await import("../../../crm-app/modules/money/manifest.js")).default;
const kit = await import("../../../crm-app/modules/money/kit.js");
const ctx = (perms = null, role = "owner") => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const XSS = "</script><script>alert(1)</script>";
const IN = "in_00000000000000000001", CT = "ct_00000000000000000001", PM = "pm_00000000000000000001";

const row = (o = {}) => ({ id: IN, n: "INV-0610", c: CT, cn: `Pat ${XSS}`, k: "standard", st: "open", tot: 29500, paid: 0, bal: 29500, due: "2026-11-17", iss: "2026-11-10", ...o });
const prow = (o = {}) => ({ id: PM, c: CT, cn: `Pat ${XSS}`, inv: IN, inn: "INV-0610", k: "payment", m: "card", st: "succeeded", a: 29500, tip: 2950, fee: 0, on: "2026-11-11", ...o });
const invoice = (o = {}) => ({
  id: IN, number: "INV-0610", kind: "standard", status: "open", contact_id: CT, contact_name: `Pat ${XSS}`, job_ids: ["jb_00000000000000000001"],
  lines: [{ id: "ln_1", kind: "service", description: `Exterior windows ${XSS}`, qty_milli: 1000, unit_cents: 29500, total_cents: 29500 }, { id: "ln_2", kind: "discount", description: "Plan discount", qty_milli: 1000, unit_cents: -2000, total_cents: -2000 }],
  total_cents: 27500, paid_cents: 0, refunded_cents: 0, tips_cents: 0, balance_cents: 27500, excess_cents: 0, issued_on: "2026-11-10", due_on: "2026-11-17", ...o,
});
const state = (o = {}, inv = {}) => ({
  invoice: invoice(inv), etag: '"e1"', flags: {}, payments: [], contact: { id: CT, display_name: `Pat ${XSS}`, has_sms: true, has_email: true, test: false },
  card: { status: "on_file", usable: true, brand: "visa", last4: "4242", kind: "card" }, sandboxed: true, system_of_record: "rotor", online: "ok",
  can: { edit: false, issue: false, send: true, record: true, charge: true, refund: true, void: true, write_off: true, card_link: true }, ...o,
});

test("the manifest: money routes behind their permissions, a Money section in the Menu, Collect payment on the Visit, the strip on Home, Settings for owners", () => {
  assert.equal(M.name, "money");
  assert.ok(M.routes.every((r) => r.perm && typeof r.load === "function" && r.parent));
  for (const p of ["/invoices", "/invoices/new", "/invoices/new/:contact", "/invoices/:id", "/payments", "/autopay", "/autopay/:id", "/settings/payments"]) assert.ok(M.routes.some((r) => r.path === p), p);
  assert.equal(M.routes.find((r) => r.path === "/invoices").split, true, "list + detail on a wide screen");
  assert.equal(M.routes.find((r) => r.path === "/settings/payments").perm, "settings:owner");
  assert.ok(M.routes.filter((r) => !r.path.startsWith("/settings")).every((r) => ["invoices:read_all", "invoices:write"].includes(r.perm)), "a tech reaches none of the money screens");
  assert.deepEqual(M.nav.map((n) => [n.path, n.section, n.where]), [["/invoices", "money", "more"], ["/payments", "money", "more"], ["/autopay", "money", "more"]]);
  assert.equal(M.creates[0].path, "/invoices/new");
  assert.equal(M.contactTabs[0].key, "money");
  const collect = M.visitActions[0];
  assert.deepEqual([collect.key, collect.label, collect.when, collect.perm, !!collect.panel], ["money.collect", "Collect payment", "any", "payments:record", false]);
  assert.equal(M.todayCards[0].key, "money");
  assert.equal(M.todayCards[0].perm, "invoices:read_all");
  assert.deepEqual(M.settings.map((s) => [s.path, s.perm]), [["/settings/payments", "settings:owner"]]);
});

test("Invoices: totals in dollars, chips with counts, rows escaped and worded by what matters first", async () => {
  const list = await load("invoices");
  const rows = [row(), row({ id: "in_00000000000000000002", n: "INV-0611", cn: "Sam Sample", af: true }), row({ id: "in_00000000000000000003", n: "INV-0612", cn: "Lee Late", od: true, pp: true, bal: 10000 })];
  const h = text(list.render({ rows, counts: { open: 3, overdue: 1, failed: 1 }, totals: { open_cents: 69000, overdue_cents: 10000 }, chip: "open", q: "", more: false }, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /href="#\/invoices\/in_00000000000000000001"/);
  assert.match(h, /\$690\.00<\/b><small>waiting to be paid/);
  assert.match(h, /class="stat bad"><b>\$100\.00/);
  assert.match(h, /Open <span class="n">3<\/span>/);
  assert.match(h, /Card failed <span class="n">1<\/span>/);
  assert.doesNotMatch(h, /data-chip="overpaid"/, "a chip with nothing in it stays out of the way");
  assert.match(h, /Card failed<\/span>/);
  assert.match(h, /Overdue<\/span>/, "overdue wins over part paid");
  assert.match(text(list.render({ rows, counts: {}, totals: {}, chip: "open", q: "sam", more: false }, ctx())), /Sam Sample/);
  assert.doesNotMatch(text(list.render({ rows, counts: {}, totals: {}, chip: "open", q: "sam", more: false }, ctx())), /Lee Late/);
  assert.match(text(list.render({ rows: [], counts: {}, totals: {}, chip: "overdue", q: "", more: false }, ctx())), /Nothing overdue/);
  assert.equal(list.action({}, ctx(["invoices:read_all"])), null, "no New for a login that can't write invoices");
  assert.equal(list.action({}, ctx()).label, "New");
  assert.deepEqual(kit.statusOf({ st: "paid", ex: 500 }), ["green", "Overpaid"]);
  assert.deepEqual(kit.statusOf({ st: "open", pr: true, af: true }), ["blue", "Clearing"]);
});

test("one invoice: lines, balance, the card, and only the buttons its state and the login allow; escaped", async () => {
  const view = await load("invoice");
  const h = text(view.render(state({ payments: [{ id: PM, kind: "payment", method: "card", status: "succeeded", total_cents: 11000, amount_cents: 10000, tip_cents: 1000, refunded_cents: 0, received_on: "2026-11-11", card: { last4: "4242" }, simulated: true }] }, { paid_cents: 10000, tips_cents: 1000, balance_cents: 17500 }), ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /Invoice INV-0610/);
  assert.match(h, /class="big">\$175\.00/);
  assert.match(h, /−\$20\.00/);
  assert.match(h, /Tips for the crew<\/span><span class="a">\$10\.00/);
  assert.match(h, /data-act="send"/);
  assert.match(h, /data-act="record"/);
  assert.match(h, /data-act="charge"/);
  assert.match(h, /data-refund="pm_00000000000000000001" data-left="11000"/);
  assert.match(h, /tip \$10\.00 · test/);
  assert.match(h, /VISA ending 4242 · On file/);
  assert.match(h, /class="pill">Test<\/span>/, "a record made here is marked while Rotor is in charge");
  // an imported invoice before the switch: says why nothing online runs, offers no card button
  const imp = text(view.render(state({ sandboxed: false, online: "not_yet", rotor_owned: true, can: {} }, { rotor: { status_raw: "sent" } }), ctx()));
  assert.match(imp, /still Rotor(&#39;|')s until the switch/);
  assert.doesNotMatch(imp, /data-act=/, "read here, changed in Rotor");
  assert.match(imp, /From Rotor/);
  // an invoice the office typed in for a customer Rotor still bills: cash can be written down, a card can't be charged
  const typed = text(view.render(state({ sandboxed: true, online: "not_yet", can: { send: true, record: true, charge: false, card_link: false } }), ctx()));
  assert.match(typed, /Rotor still bills this customer/);
  assert.match(typed, /data-act="record"/);
  assert.doesNotMatch(typed, /data-act="charge"/);
  // paid: nothing to collect; an overpayment asks for a decision
  const paid = text(view.render(state({ can: { refund: true } }, { status: "paid", balance_cents: 0, paid_cents: 30000, excess_cents: 2500 }), ctx()));
  assert.match(paid, /Overpaid/);
  assert.match(paid, /data-act="keep"/);
  assert.doesNotMatch(paid, /data-act="record"/);
  assert.equal(view.title(state()), "INV-0610");
});

test("Payments and the contact's Money tab: the month's totals, practice payments marked, credit and the card", async () => {
  const pay = await load("payments");
  const h = text(pay.render({ rows: [prow(), prow({ id: "pm_00000000000000000002", k: "refund", a: 5000, tip: 0 }), prow({ id: "pm_00000000000000000003", sim: true, m: "cash", tip: 0 })], totals: { collected_cents: 27450, tips_cents: 2950, fees_cents: 0, refunds_cents: 5000, simulated: 1 }, by: { card: 32450 }, month: "2026-11", method: "" }, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /November 2026/);
  assert.match(h, /\$274\.50<\/b><small>came in/);
  assert.match(h, /tip \$29\.50/);
  assert.match(h, /−\$50\.00/);
  assert.match(h, /1 practice payment \(marked "test"\) is listed but never counted/);
  assert.match(text(pay.render({ rows: [], totals: {}, by: {}, month: "2026-11", method: "" }, ctx())), /No payments this month/);
  const tab = await load("contact-tab");
  const th = text(tab.render({ id: CT, invoices: [row()], payments: [prow()], more: {}, credit: { balance_cents: 2500, held_cents: 1000, rows: [{ id: "cr_1", kind: "goodwill", amount_cents: 2500, status: "available", note: `Sorry ${XSS}` }] }, card: { status: "failed", pm: { kind: "card", brand: "visa", last4: "4242" } }, open_balance_cents: 29500, can: { credit: true, invoice: true, card_link: true } }, ctx()));
  assert.ok(!th.includes("<script>alert(1)"));
  assert.match(th, /class="stat bad"><b>\$295\.00/);
  assert.match(th, /\$25\.00<\/b><small>account credit \(\+\$10\.00 to decide\)/);
  assert.match(th, /href="#\/invoices\/new\/ct_00000000000000000001"/);
  assert.match(th, /VISA ending 4242 · Failed last time/);
  assert.match(th, /data-mn-credit/);
  assert.equal(tab.events, undefined, "the Contact screen doesn't route a tab's taps: the tab listens for its own two buttons");
  const ro = text(tab.render({ id: CT, invoices: [], payments: [], more: {}, credit: { balance_cents: 0, rows: [] }, card: { status: "none" }, open_balance_cents: 0, can: {} }, ctx()));
  assert.doesNotMatch(ro, /data-mn-credit|New invoice|data-mn-card-link/);
  assert.match(ro, /No card on file/);
  assert.match(text(tab.render({ denied: true }, ctx())), /Not for this login/);
});

test("Autopay, a run, Settings → Payments and the Home strip: the preview says what Rotor still bills; the mode is plain; live waits for the switch", async () => {
  const ap = await load("autopay");
  const item = (o = {}) => ({ plan_id: "pl_00000000000000000001", contact_id: CT, contact_name: `Pat ${XSS}`, plan_name: "Quarterly plan", amount_cents: 19500, visits: [{ term: 1, n: 2, amount_cents: 19500 }], autopay: true, card: "ok", paused: false, imported: false, would: "charge", ...o });
  const h = text(ap.render({ preview: { month: "2027-01", items: [item(), item({ plan_id: "pl_00000000000000000002", contact_name: "Sam Sample", imported: true, would: "would_charge" }), item({ plan_id: "pl_00000000000000000003", contact_name: "Lee Late", card: "none", would: "skipped_no_card" })], totals: { plans: 3, amount_cents: 58500, charge_cents: 19500, would_charge_cents: 19500, no_card: 1 } }, runs: [{ id: "ap_00000000000000000001", m: "2026-12", st: "done", n: 2, ok: 39000, f: 1, w: 0 }] }, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /January 2027/);
  assert.match(h, /\$585\.00<\/b><small>3 plans/);
  assert.match(h, /Billed by Rotor/);
  assert.match(h, /No card/);
  assert.match(h, /href="#\/autopay\/ap_00000000000000000001"/);
  assert.match(h, /2 plans · 1 failed/);
  const run = await load("autopay-run");
  const rh = text(run.render({ run: { id: "ap_00000000000000000001", month: "2026-12", status: "done", late: true, finished_at: "2026-12-02T15:00:00.000Z", items: [{ plan_id: "pl_00000000000000000001", amount_cents: 19500, result: "failed", code: "card_declined", invoice_id: IN }], totals: { succeeded_cents: 0, failed: 1 } }, names: { pl_00000000000000000001: { contact_name: `Pat ${XSS}`, plan_name: "Quarterly plan" } } }, ctx()));
  assert.ok(!rh.includes("<script>alert(1)"));
  assert.match(rh, /it ran late/);
  assert.match(rh, /card declined/);
  assert.match(rh, /href="#\/invoices\/in_00000000000000000001"/);
  const set = await load("settings");
  const st = (o = {}) => ({ mode: "dry_run", wanted: "dry_run", refused: null, system_of_record: "rotor", production: true, keys: { STRIPE_SECRET_KEY: "live", STRIPE_TEST_SECRET_KEY: "missing", STRIPE_WEBHOOK_SECRET: "missing", STRIPE_TEST_WEBHOOK_SECRET: "missing" }, foreign_events: 2, webhooks: { live: "/api/crm/hooks/stripe", test: "/api/crm/hooks/stripe-test" }, ...o });
  const cfg = { auto_issue: true, receipt_email: true, ach: true, overdue_every_days: 3, overdue_max: 5, tip_options_bp: [0, 1000, 1500, 2000], tip_custom_max_cents: 50000, retry_days: [3, 7], statement_descriptor: "BARTA WINDOWS", credit_cap_admin_cents: 10000 };
  const sh = text(set.render({ st: st(), cfg, etag: "new" }, ctx()));
  assert.match(sh, /data-mode-now="dry_run">Dry run/);
  assert.match(sh, /Nothing is charged for real/);
  assert.match(sh, /data-mode="live" aria-pressed="false" disabled/, "live can't be picked while Rotor is in charge");
  assert.match(sh, /STRIPE_SECRET_KEY<\/dt><dd>a live key/);
  assert.match(sh, /2 Stripe events about payments the CRM didn't make were ignored/);
  assert.match(sh, /value="0, 10, 15, 20"/);
  assert.doesNotMatch(sh, /sk_|rk_|whsec_/, "never a key's value");
  const refused = text(set.render({ st: st({ wanted: "live", refused: "live_waits_for_cutover" }), cfg, etag: "new" }, ctx()));
  assert.match(refused, /Live payments wait for the switch from Rotor/);
  assert.match(text(set.render({ st: st({ mode: "live", wanted: "live", system_of_record: "crm" }), cfg, etag: "new" }, ctx())), /Real money/);
  const card = await load("today-card");
  assert.equal(text(card.render(null)), "");
  assert.equal(text(card.render({ open_cents: 0, revenue_cents: 0 })), "", "nothing owed, nothing in: no strip");
  const ch = text(card.render({ open_cents: 69000, overdue_cents: 10000, revenue_cents: 120000 }));
  assert.match(ch, /\$690\.00<\/b><small>owed to you/);
  assert.match(ch, /class="bad" href="#\/invoices\?status=overdue"><b>\$100\.00/);
});

// ------------------------------------------------------------ the QR code for a pay link

const qr = await import("../../../crm-app/modules/money/qr.js");

// Reads a finished symbol back (no damage to correct): the format bits, the
// mask off, the zigzag, the blocks apart, each block's check, byte mode.
function decode(rows) {
  const size = rows.length, ver = (size - 17) / 4;
  const fmt = [];
  for (let i = 0; i <= 5; i++) fmt[i] = rows[i][8];
  fmt[6] = rows[7][8]; fmt[7] = rows[8][8]; fmt[8] = rows[8][7];
  for (let i = 9; i < 15; i++) fmt[i] = rows[8][14 - i];
  const bits = fmt.reduce((v, b, i) => v | ((b ? 1 : 0) << i), 0);
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => qr.formatBits(k) === bits);
  assert.ok(mask !== undefined, "format bits of error correction M and one of the eight masks");
  // which modules are fixed patterns: build the same symbol's map from a blank one
  const blank = qr.qrMatrix("x".repeat(qr.dataCodewords(ver) - 3), { mask });
  assert.equal(blank.size, size);
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  const ap = qr.alignmentPositions(ver);
  ap.forEach((ax, i) => ap.forEach((ay, j) => { if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy); }));
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (ver >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + (i % 3), Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + (i % 3)); }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const stream = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x]) stream.push(rows[y][x] !== MASKS[mask](x, y) ? 1 : 0);
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= stream.length; i += 8) cw.push(stream.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  return { ver, mask, codewords: cw };
}

test("the QR code: a real symbol (format and version bits per the standard), the link reads back from it, quiet zone, black on white", () => {
  // ISO 18004 Annex C: the 15 format bits for error correction M, masks 0 to 7
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => qr.formatBits(k).toString(2).padStart(15, "0")), ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"]);
  // Annex D: the 18 version bits
  assert.equal(qr.versionBits(7), 0x07c94);
  assert.equal(qr.versionBits(10), 0x0a4d3);
  // data capacity of versions 1 to 10 at M (the standard's table)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(qr.dataCodewords), [16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
  assert.deepEqual(qr.alignmentPositions(1), []);
  assert.deepEqual(qr.alignmentPositions(7), [6, 22, 38]);
  for (const link of ["https://example.com/p/Zk3mQ9x7Lw2Rt8Vb5Nc1Ha6Yd4Ue0Ji", "https://example.com/p/" + "a".repeat(140), "https://example.com/p/" + "b".repeat(420)]) {
    const q = qr.qrMatrix(link);
    assert.equal(q.size, q.version * 4 + 17);
    const d = decode(q.rows);
    // byte mode: 0100, the length, then the bytes
    const bitsOf = d.codewords.flatMap((c) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (c >> i) & 1));
    // the codewords are interleaved by block: with one block the data reads straight off
    if (q.version < 4) {
      assert.equal(bitsOf.slice(0, 4).join(""), "0100");
      const len = parseInt(bitsOf.slice(4, 12).join(""), 2);
      const bytes = [];
      for (let i = 0; i < len; i++) bytes.push(parseInt(bitsOf.slice(12 + i * 8, 20 + i * 8).join(""), 2));
      assert.equal(new TextDecoder().decode(new Uint8Array(bytes)), link);
    }
    assert.equal(d.codewords.length >= qr.dataCodewords(q.version), true);
  }
  // one block (version 1): the check bytes are the remainder of the data, so the whole block divides evenly
  const one = qr.qrMatrix("pay 123");
  assert.equal(one.version, 1);
  const cw = decode(one.rows).codewords;
  assert.equal(cw.length, 26);
  const gf = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
  for (let i = 0, root = 1; i < 10; i++, root = gf(root, 2)) assert.equal(cw.reduce((v, c) => gf(v, root) ^ c, 0), 0, `Reed-Solomon syndrome ${i}`);
  const svg = qr.qrSvg("https://example.com/p/abc", { label: 'Scan "to" <pay>' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 33 33"/, "25 modules and a four-module quiet zone on every side");
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /fill="#000"/);
  assert.doesNotMatch(svg, /<pay>|"to"/, "the label can't break out of its attribute");
  assert.throws(() => qr.qrMatrix("x".repeat(3000)), RangeError, "more than a version 40 symbol holds");
});
