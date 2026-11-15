// The Rotor-style kit (Nov 2026; core/ui.js helpers, the router's header
// contract, styles/crm.css): markup, tap targets by class, escaping, the
// "..." rows, and every class a helper draws has its look in the stylesheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = await import("../../../crm-app/core/ui.js");
const { headerKit } = await import("../../../crm-app/core/router.js");
const { rnd, statusPill, pillTone, pillTap, pillBtn, seg, cardHead, sectionLabel, statGrid, contactRows, personCard, addressCard, lineItems, notesBox, disclosure, formRow, formRows, toggle, quickRow, dataOf, UnsafeHtml } = ui;
const h = (x) => String(x);
const CSS = readFileSync("crm-app/styles/crm.css", "utf8");

test("dataOf: data-* names, true as an empty value, false and null left out", () => {
  assert.deepEqual(dataOf({ pick: "owner", "data-x": 1, on: true, off: false, gone: null }), { "data-pick": "owner", "data-x": "1", "data-on": "" });
  assert.deepEqual(dataOf(null), {});
});

test("rnd: a button, a link, a link that leaves; tones and the small one", () => {
  const b = h(rnd("edit", "Edit lead", { tone: "grey", sm: true, data: { edit: true } }));
  assert.match(b, /^<button type="button" class="rnd grey sm" aria-label="Edit lead" data-edit="">/);
  assert.match(b, /<svg/);
  assert.match(h(rnd("call", "Call", { tone: "red", href: "tel:+17635550100" })), /^<a href="tel:\+17635550100" class="rnd red"/);
  assert.match(h(rnd("nav", "Directions", { ext: "maps:?q=Delano" })), /data-external="top"/);
  assert.match(h(rnd("nav", "Directions", { ext: "https://maps.example.com/?q=Delano" })), /target="_blank" rel="noopener"/);
  assert.match(h(rnd("search", "Search", { tone: "solid" })), /class="rnd on"/);
  assert.match(h(rnd("inbox", "Inbox", { badge: 120 })), /<span class="badge">99\+<\/span>/);
  assert.match(h(rnd("more", "More", { popup: true, id: "x" })), /id="x" aria-label="More" aria-haspopup="dialog"/);
  assert.throws(() => rnd("call", "Call", { href: "javascript:alert(1)" }), UnsafeHtml);
  assert.match(h(rnd("call", "Call", { data: { onclick: "x" } })), /data-onclick="x"/, "data: is always data-*, never a handler");
  assert.throws(() => rnd("call", "Call", { data: { "a b": 1 } }), UnsafeHtml, "a bad attribute name is refused");
});

test("pills: the status colour map, given tones, a pill that is a 44 px button", () => {
  assert.equal(pillTone("Booked"), "blue");
  assert.equal(pillTone("paid"), "green");
  assert.equal(pillTone("To book"), "amber");
  assert.equal(pillTone("Overdue"), "red");
  assert.equal(pillTone("High priority"), "orange");
  assert.equal(pillTone("Draft"), "grey");
  assert.equal(pillTone("Anything else"), "grey");
  assert.equal(h(statusPill("Sent")), '<span class="pill blue">Sent</span>');
  assert.equal(h(statusPill("Draft")), '<span class="pill">Draft</span>');
  assert.equal(h(statusPill("Medium")), '<span class="pill fill-orange">Medium</span>');
  assert.equal(h(statusPill("Olive Owner", "white")), '<span class="pill wh">Olive Owner</span>');
  assert.equal(h(statusPill("<b>x</b>")), '<span class="pill">&lt;b&gt;x&lt;/b&gt;</span>', "escaped");
  assert.match(h(pillTap("Olive Owner", { data: { owner: true } })), /^<button type="button" class="rs-pilltap" data-owner=""><span class="pill wh">Olive Owner<\/span><\/button>$/);
  assert.match(h(pillBtn("Visit", { icon: "plus", tone: "solid" })), /^<button type="button" class="rs-pb solid"><svg[^]*<span>Visit<\/span><\/button>$/);
  assert.match(h(pillBtn("Create Invoice", { wide: true, href: "#/invoices/new" })), /^<a href="#\/invoices\/new" class="rs-pb wide">/);
});

test("seg: tabs with aria, one selected and focusable, counts, links, the black variant", () => {
  const s = h(seg([["details", "Details"], ["activity", "Activity"]], "activity", { name: "tab", label: "Lead" }));
  assert.match(s, /^<div class="rs-seg" role="tablist" aria-label="Lead">/);
  assert.match(s, /role="tab" aria-selected="false" tabindex="-1" data-seg="tab" data-key="details"/);
  assert.match(s, /role="tab" aria-selected="true" tabindex="0" data-seg="tab" data-key="activity"/);
  const b = h(seg([{ key: "list", label: "List", href: "#/schedule?view=list" }, { key: "day", label: "Day", count: 3 }, null], "day", { name: "view", black: true }));
  assert.match(b, /class="rs-seg black"/);
  assert.match(b, /^<div[^>]*><a href="#\/schedule\?view=list" class="rs-seg-b"/);
  assert.match(b, /<span class="n">3<\/span>/);
  assert.equal((b.match(/role="tab"/g) || []).length, 2, "a falsy item is skipped");
});

test("cardHead, sectionLabel, statGrid", () => {
  const c = h(cardHead("Quotes", { add: { label: "New quote", href: "#/quotes/new" }, edit: { data: { edit: true } }, count: "2 quotes" }));
  assert.match(c, /^<div class="rs-ch"><h3>Quotes<\/h3><span class="rs-ch-n">2 quotes<\/span><span class="rs-ch-end">/);
  assert.ok(c.indexOf('aria-label="Edit"') < c.indexOf('aria-label="New quote"'), "the pencil, then the +");
  assert.match(c, /<a href="#\/quotes\/new" class="rnd grey sm" aria-label="New quote">/);
  assert.equal(h(cardHead("Tasks")), '<div class="rs-ch"><h3>Tasks</h3><span class="rs-ch-end"></span></div>');
  assert.equal(h(sectionLabel("Contact")), '<h2 class="rs-label">Contact</h2>');
  const g = h(statGrid([{ label: "Stage", value: "Quoted", href: "#/deals/d1" }, { label: "Value", value: "" }, { label: "Balance", value: "$5.00", tone: "red", data: { pay: true } }, { label: "Source", value: "Website", wide: true }, false], { label: "Lead details" }));
  assert.match(g, /^<div class="rs-card rs-stat" role="group" aria-label="Lead details">/);
  assert.match(g, /<a class="rs-stat-c" href="#\/deals\/d1">/);
  assert.match(g, /<span class="rs-stat-v">-<\/span>/, "an empty value reads as a plain dash, never an em dash");
  assert.match(g, /<button type="button" class="rs-stat-c" data-pay=""><span class="rs-stat-l">Balance<\/span><span class="rs-stat-v red">\$5\.00<\/span>/);
  assert.match(g, /<div class="rs-stat-c wide">/);
});

test("contactRows, personCard, addressCard", () => {
  const r = h(contactRows([
    { icon: "call", label: "Mobile", value: "(763) 555-0100", actions: [{ icon: "chat", label: "Text", href: "sms:+17635550100" }, { icon: "call", label: "Call", tone: "red", href: "tel:+17635550100" }] },
    { icon: "mail", label: "Email", value: "a@example.com", href: "mailto:a@example.com" },
    { icon: "pin", label: "Address", value: "<img src=x>", data: { addr: true } },
    null,
  ]));
  assert.match(r, /^<ul class="rs-card rs-crows"><li class="rs-crow"><span class="rs-ci" aria-hidden="true"><svg/);
  assert.match(r, /<span class="rs-cv"><span class="rs-cl">Mobile<\/span><span class="rs-cval">\(763\) 555-0100<\/span><\/span><span class="rs-acts"><a href="sms:\+17635550100" class="rnd grey sm"/);
  assert.match(r, /class="rnd red sm" aria-label="Call"/);
  assert.match(r, /<a class="rs-cv" href="mailto:a@example.com">/);
  assert.match(r, /<button type="button" class="rs-cv" data-addr="">/);
  assert.match(r, /&lt;img src=x&gt;/);
  assert.equal((r.match(/<li /g) || []).length, 3);
  const p = h(personCard({ name: "Robin Workday", sub: "(763) 555-0101", href: "#/contacts/ct_1", call: "tel:+17635550101", text: { data: { text: true } } }));
  assert.match(p, /^<div class="rs-card rs-person"><a class="rs-pl" href="#\/contacts\/ct_1"><span class="rs-av" aria-hidden="true">RW<\/span>/);
  assert.match(p, /<a href="tel:\+17635550101" class="rnd red sm" aria-label="Call Robin Workday">/);
  assert.match(p, /<button type="button" class="rnd grey sm" aria-label="Text Robin Workday" data-text="">/);
  assert.match(h(personCard({ name: "" })), /<span class="rs-av" aria-hidden="true">\?<\/span>/);
  const a = h(addressCard({ line1: "700 Example Ave", line2: "Delano, MN · gate 1234", nav: "maps:?q=700+Example+Ave", edit: { label: "Edit access", data: { access: true } } }));
  assert.match(a, /^<div class="rs-card rs-addr"><span class="rs-pl"><span class="rs-ci" aria-hidden="true">/);
  assert.match(a, /href="maps:\?q=700\+Example\+Ave" data-external="top" class="rnd grey sm" aria-label="Directions"/);
  assert.match(a, /aria-label="Edit access" data-access=""/);
  assert.match(h(addressCard({ line1: "x", nav: { href: "#/map" } })), /<a href="#\/map" class="rnd grey sm" aria-label="Directions">/);
});

test("lineItems: qty × unit, money from cents, + Item, subtotal, discounts, total, paid, the wide button", () => {
  const l = h(lineItems([{ title: "Exterior window cleaning", qty: 1, unit: 29500, amount: 29500 }, { title: "Screens", qty: 12, unit: 500, amount: 6000, data: { line: 1 } }, { title: "Custom", sub: "", amount: "$1.00" }], {
    addItem: { data: { add: true } }, subtotal: 35500, discounts: [{ label: "Plan discount", amount: -3550 }], addDiscount: { label: "Add discount", data: { disc: true } }, total: 31950, paid: true, cta: { label: "Create Invoice", data: { invoice: true } },
  }));
  assert.match(l, /<span class="rs-li-t">Exterior window cleaning<\/span><span class="rs-li-s">1 × \$295\.00<\/span><\/span><span class="rs-li-m num">\$295\.00<\/span>/);
  assert.match(l, /<button type="button" class="rs-li" data-line="1">/);
  assert.match(l, /<span class="rs-li-t">Custom<\/span><\/span><span class="rs-li-m num">\$1\.00<\/span>/, "a ready string, no sub line");
  assert.match(l, /data-add=""><svg[^]*?<span>Item<\/span>/);
  assert.match(l, /<div class="rs-li-sum"><span>Subtotal<\/span><span class="num">\$355\.00<\/span><\/div>/);
  assert.match(l, /<span>Plan discount<\/span><span class="num">−\$35\.50<\/span>/);
  assert.match(l, /data-disc=""><svg[^]*?<span>Add discount<\/span>/);
  assert.match(l, /<div class="rs-li-tot"><span>Total<\/span><span class="num paid">\$319\.50<\/span><\/div>/);
  assert.match(l, /<p class="rs-paid">Paid in full<\/p>/);
  assert.match(l, /<button type="button" class="rs-pb wide" data-invoice=""><span>Create Invoice<\/span><\/button>/);
  assert.ok(l.indexOf("Subtotal") < l.indexOf("Plan discount") && l.indexOf("Plan discount") < l.indexOf("Add discount") && l.indexOf("Add discount") < l.indexOf("Total"), "in Rotor's order");
  assert.match(h(lineItems([], { empty: "No lines yet" })), /<p class="rs-empty">No lines yet<\/p>/);
  assert.match(h(lineItems([], { total: 0, paid: "Paid Jun 24" })), /<span class="num paid">\$0\.00<\/span>[^]*<p class="rs-paid">Paid Jun 24<\/p>/);
  // a discount row may be a button or a link (the job page: tap to change it)
  const d = h(lineItems([], { discounts: [{ label: "Neighbor deal", amount: -2500, data: { disc: "dc_1" } }, { label: "Plan", amount: -100, href: "#/plans/x" }] }));
  assert.match(d, /<button type="button" class="rs-li-sum tap" data-disc="dc_1"><span>Neighbor deal<\/span><span class="num">−\$25\.00<\/span><\/button>/);
  assert.match(d, /<a class="rs-li-sum tap" href="#\/plans\/x"><span>Plan<\/span>/);
});

test("notesBox, disclosure, form rows, toggle, quickRow", () => {
  assert.equal(h(notesBox("Dog in </textarea><b>", { name: "crew", label: "Notes for the crew", placeholder: "Add notes for this job..." })),
    '<textarea class="rs-notes" data-notes="crew" aria-label="Notes for the crew" placeholder="Add notes for this job..." rows="3">Dog in &lt;/textarea&gt;&lt;b&gt;</textarea>');
  assert.match(h(notesBox("", { readonly: true })), /readonly/);
  assert.equal(h(disclosure("Sold by", { value: "Olive Owner", href: "#/team/us_1" })), '<a class="rs-card rs-disc" href="#/team/us_1"><span class="rs-dl"><span>Sold by · <b>Olive Owner</b></span></span><span class="chev" aria-hidden="true"></span></a>');
  assert.match(h(disclosure("Activity", { sub: "changed just now", data: { log: true } })), /^<button type="button" class="rs-card rs-disc" data-log=""><span class="rs-dl"><span>Activity<\/span><span class="rs-ds">changed just now<\/span>/);
  const sw = h(toggle(true, { data: { autopay: true }, label: "Auto-Pay" }));
  assert.equal(sw, '<button type="button" class="switch" role="switch" aria-checked="true" aria-label="Auto-Pay" data-autopay=""></button>');
  assert.match(h(toggle(false, { disabled: true })), /aria-checked="false" disabled/);
  const f = h(formRows([formRow("Auto-Pay", toggle(false), { hint: "Visa ending 4242" }), null]));
  assert.match(f, /^<div class="rs-card rs-frows"><label class="rs-frow"><span class="rs-fl">Auto-Pay<small>Visa ending 4242<\/small><\/span><span class="rs-fc"><button/);
  const q = h(quickRow([{ icon: "call", label: "Call", href: "tel:+17635550100" }, { icon: "camera", label: "Photos", badge: 2, data: { photos: true } }, { icon: "nav", label: "Navigate", ext: "maps:?q=x" }]));
  assert.match(q, /^<div class="rs-qrow"><a href="tel:\+17635550100" class="rs-q"><span class="rs-q-c"><svg/);
  assert.match(q, /<button type="button" class="rs-q" data-photos=""><span class="rs-q-c"><svg[^]*?<span class="badge">2<\/span><\/span><span class="rs-q-l">Photos<\/span>/);
  assert.match(q, /data-external="top" class="rs-q"/);
  assert.doesNotMatch(q, /aria-label/, "the label is the name unless one is given");
  assert.match(h(quickRow([{ icon: "qr", label: "QR", aria: "Show QR to pay", data: { act: "qr" } }])), /<button type="button" class="rs-q" aria-label="Show QR to pay" data-act="qr">/);
});

test("the router's header contract: at most two tools, the ... only with rows, asked again on the tap", () => {
  assert.equal(headerKit({}, {}, {}), null, "a screen without tools or more keeps its header");
  assert.equal(headerKit(null, {}, {}), null);
  const ctx = { state: { n: 1 } };
  const mod = {
    tools: () => [{ icon: "edit", label: "Edit" }, null, { icon: "share", label: "Share" }, { icon: "copy", label: "Copy" }],
    more: (s) => [[s.n > 1 && { label: "Later" }, { label: "Reopen" }], [false]],
    moreTitle: (s) => `Job ${s.n}`,
  };
  const k = headerKit(mod, ctx.state, ctx);
  assert.deepEqual(k.tools.map((t) => t.label), ["Edit", "Share"], "falsy tools dropped, two at most");
  assert.equal(k.hasMore, true);
  ctx.state = { n: 2 };
  assert.deepEqual(k.open()[0].filter(Boolean).map((r) => r.label), ["Later", "Reopen"], "the rows see the latest state");
  assert.equal(k.sheetTitle(), "Job 2");
  assert.equal(headerKit({ more: () => [[null, false], []] }, {}, { state: {} }).hasMore, false, "no rows, no ...");
  assert.equal(headerKit({ more: () => { throw new Error("boom"); } }, {}, { state: {} }).hasMore, false, "a broken more() never breaks the header");
  assert.deepEqual(headerKit({ tools: () => null }, {}, {}).tools, []);
});

test("every class the kit draws has its look in crm.css; Customize Tabs and the drawer have theirs too", () => {
  const out = [
    rnd("edit", "x", { tone: "grey", sm: true }), rnd("call", "x", { tone: "red" }), statusPill("Booked"), statusPill("x", "white"), pillTap("x"), pillBtn("x", { tone: "solid", wide: true }), pillBtn("x", { tone: "red" }),
    seg([["a", "A"]], "a", { black: true }), cardHead("x", { add: {}, count: 1 }), sectionLabel("x"), statGrid([{ label: "x", value: 1, tone: "red", wide: true }]),
    contactRows([{ label: "x", value: "y", sub: "z", actions: [{ icon: "call", label: "c" }] }]), personCard({ name: "x", sub: "y" }), addressCard({ line1: "x", line2: "y" }),
    lineItems([{ title: "x", qty: 1, unit: 1, amount: 1 }], { addItem: {}, subtotal: 1, total: 1, paid: true, cta: { label: "x" } }), lineItems([]), notesBox(""), disclosure("x", { sub: "y" }),
    formRows([formRow("x", toggle(true), { hint: "y" })]), quickRow([{ icon: "call", label: "x", badge: 1, tone: "red" }]),
  ].map(String).join("");
  const classes = new Set([...out.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const missing = [...classes].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`).test(CSS));
  assert.deepEqual(missing, []);
  for (const c of ["ctb-list", "ctb-row", "ctb-div", "ctb-drag", "fm-sheet", "fm-row", "fm-card", "fm-tile", "fm-prev", "top-bar", "set-ic", "rs-actions", "rs-act", "rs-act-g", "rs-sheetpage", "rs-done", "rs-sp-pane", "rs-top", "rs-shell", "rs-dashed", "rs-sat", "rs-page", "rs-name", "rs-amt", "rs-inset"]) assert.match(CSS, new RegExp(`\\.${c}\\b`), c);
  // the tokens: light Flyra's calm (Polish 3: a faint grey canvas, white cards with one hairline, no card shadow), dark ours, under the same names
  assert.match(CSS, /:root\{[^}]*--mist:#f6f6f8;[^}]*--card:#fff;--card-2:#f3f3f6;/);
  assert.match(CSS, /:root\{[^}]*--sh-card:none;[^}]*--card-line:var\(--line\);/);
  assert.match(CSS, /--seg-track:#ececf0;/);
  assert.match(CSS, /--card:#1b1c1f;--card-2:#232428;/);
  assert.match(CSS, /--seg-track:#1d1e21;--seg-on:#48494d;/);
});

// ------------------------------------------------------------ K0: the list and board patterns (the Rotor guide §0)

test("tileRow: the tile is the filter (aria-pressed on the one that is on), info tiles aren't buttons, money, tones, links", () => {
  const { tileRow, tileToggle } = ui;
  const t = h(tileRow([{ key: "all", label: "All", value: 82 }, { key: "overdue", label: "Overdue", value: 3, money: 67500, tone: "red" }, { key: "arr", label: "ARR", value: "$12,480", info: true }, { key: "x", label: "Empty" }], { name: "inv", on: "overdue", label: "Invoices" }));
  assert.match(t, /^<div class="rs-tiles" role="group" aria-label="Invoices"><div class="rs-tiles-in">/);
  assert.match(t, /<button type="button" class="rs-tile" data-tile="inv" data-key="all" aria-pressed="false"><span class="rs-tile-l">All<\/span><span class="rs-tile-v num">82<\/span><\/button>/);
  assert.match(t, /class="rs-tile red" data-tile="inv" data-key="overdue" aria-pressed="true">[\s\S]*<span class="rs-tile-m num">\$675\.00<\/span>/);
  assert.match(t, /<div class="rs-tile info"><span class="rs-tile-l">ARR<\/span><span class="rs-tile-v num">\$12,480<\/span><\/div>/, "info: not tappable");
  assert.match(t, /data-key="x" aria-pressed="false"><span class="rs-tile-l">Empty<\/span><span class="rs-tile-v num">-<\/span>/, "no value: -");
  assert.match(h(tileRow([{ key: "a", label: "A", value: 1, href: "#/tasks?due=today" }], { on: "a", big: true })), /^<div class="rs-tiles big"[\s\S]*<a href="#\/tasks\?due=today" class="rs-tile" data-tile="tile" data-key="a" aria-current="true">/);
  assert.equal(tileToggle("overdue", "overdue"), "all", "a tap on the tile that is on clears it");
  assert.equal(tileToggle("all", "sent"), "sent");
  assert.equal(tileToggle("sent", "sent", null), null);
  assert.match(h(tileRow([{ key: "<b>", label: "<i>x</i>", value: "<script>" }])), /data-key="&lt;b&gt;"[\s\S]*&lt;i&gt;x&lt;\/i&gt;[\s\S]*&lt;script&gt;/, "escaped");
});

test("listRow and listCard: two lines, the $ and the pill on the right, one round action, a red edge, a long press", () => {
  const { listRow, listCard } = ui;
  const r = h(listRow({ title: "Quinn Talkedto", amount: 22500, sub: "INV-100201 · due Nov 13", tag: "Plan", pill: "Overdue", href: "#/invoices/inv_1", edge: "red", action: { icon: "chat", label: "Text a reminder", data: { remind: "inv_1" } }, hold: { "row-more": "inv_1" } }));
  assert.match(r, /^<li class="rs-lrow edge-red" data-hold="" data-row-more="inv_1"><a class="rs-lr-main" href="#\/invoices\/inv_1">/);
  assert.match(r, /<span class="rs-lr-1"><span class="rs-lr-t">Quinn Talkedto<\/span><span class="rs-lr-m num">\$225\.00<\/span><\/span>/);
  assert.match(r, /<span class="rs-lr-2"><span class="rs-lr-s">INV-100201 · due Nov 13<span class="rs-tag">Plan<\/span><\/span><span class="pill red">Overdue<\/span><\/span>/);
  assert.match(r, /<span class="rs-acts"><button type="button" class="rnd grey sm" aria-label="Text a reminder" data-remind="inv_1">/, "one trailing round action");
  assert.match(h(listRow({ title: "x", pill: { label: "Owes $40", tone: "red" }, initials: "QT", data: { open: "c1" } })), /^<li class="rs-lrow"><button type="button" class="rs-lr-main" data-open="c1"><span class="rs-av rs-lr-av" aria-hidden="true">QT<\/span>[\s\S]*<span class="pill red">Owes \$40<\/span>/);
  assert.match(h(listRow({ title: "x", pill: ui.statusPill("Signed") })), /<span class="pill green">Signed<\/span>/, "ready html");
  assert.doesNotMatch(h(listRow({ title: "Only a name" })), /rs-lr-2|rs-acts|data-hold/, "nothing it wasn't given");
  assert.match(h(listCard([listRow({ title: "a" }), null, listRow({ title: "b" })], { label: "Invoices" })), /^<ul class="rs-card flush rs-list" aria-label="Invoices"><li class="rs-lrow">[\s\S]*<li class="rs-lrow">/);
  assert.equal(h(listCard([], { empty: "No invoices yet." })), '<div class="rs-card"><p class="rs-empty">No invoices yet.</p></div>');
  assert.throws(() => listRow({ title: "x", href: "javascript:alert(1)" }), UnsafeHtml);
});

test("board and boardCard: the stage strip with counts, the columns, the card's Move pill, overdue and done", () => {
  const { board, boardCard } = ui;
  const card = h(boardCard({ title: "Avery Newlead", pill: "High", sub: "Website · $0", meta: "Created Nov 14", edge: "red", href: "#/contacts/ct_1", move: { data: { move: "ct_1" } }, action: { icon: "call", label: "Call Avery", tone: "red", href: "tel:+17635550100" }, hold: { card: "ct_1" } }));
  assert.match(card, /^<article class="rs-bcard edge-red" data-hold="" data-card="ct_1"><a class="rs-bc-main" href="#\/contacts\/ct_1"><span class="rs-bc-1"><span class="rs-bc-t">Avery Newlead<\/span><span class="pill fill-orange">High<\/span><\/span><span class="rs-bc-s">Website · \$0<\/span><span class="rs-bc-m">Created Nov 14<\/span><\/a>/);
  assert.match(card, /<div class="rs-bc-acts"><button type="button" class="rs-pb" aria-label="Move Avery Newlead" data-move="ct_1">[\s\S]*<span>Move<\/span><\/button><a href="tel:\+17635550100" class="rnd red sm" aria-label="Call Avery">/);
  assert.match(h(boardCard({ title: "Old task", done: true })), /^<article class="rs-bcard done"><span class="rs-bc-main">/);
  const b = h(board({ name: "leads", label: "Leads", on: "contacted", columns: [{ key: "new", label: "New", count: 503, cards: [card] }, { key: "contacted", label: "Contacted", cards: [], amount: 45000 }] }));
  assert.match(b, /^<div class="rs-board" data-board="leads" data-on="contacted" role="region" aria-label="Leads">/);
  assert.match(b, /<button type="button" class="rs-strip-b" data-board-jump="leads" data-key="new" aria-pressed="false"><span>New<\/span><span class="n num">503<\/span><\/button>/);
  assert.match(b, /data-key="contacted" aria-pressed="true"><span>Contacted<\/span><span class="n num">0<\/span>/, "a count from the cards when none is given");
  assert.match(b, /<section class="rs-col" data-col="contacted" aria-label="Contacted"><header class="rs-col-h"><h3>Contacted<\/h3><span class="rs-col-n num">0 · \$450\.00<\/span><\/header>\s*<div class="rs-col-cards"><p class="rs-empty">Nothing here<\/p><\/div>/);
  assert.match(h(board({ columns: [{ key: "a", label: "A", cards: [] }] })), /data-board="board" data-on="a"/, "the first column when none is on");
});

test("periods: the ranges (weeks from Monday), the labels, the chip; stepper, the sticky step, the empty card, scrolling tabs, the drag handle", () => {
  const { periodRange, periodLabel, periodChip, PERIODS, stepper, stickyCta, emptyCard, seg, dragHandle } = ui;
  assert.deepEqual(PERIODS.map(([, l]) => l), ["This week", "This month", "Last month", "Last 3 months", "This year", "Custom"]);
  assert.deepEqual(periodRange("week", "2026-11-14"), { from: "2026-11-09", to: "2026-11-14" }, "Saturday: from Monday");
  assert.deepEqual(periodRange("week", "2026-11-16"), { from: "2026-11-16", to: "2026-11-16" }, "a Monday");
  assert.deepEqual(periodRange("month", "2026-11-14"), { from: "2026-11-01", to: "2026-11-14" });
  assert.deepEqual(periodRange("last_month", "2026-01-14"), { from: "2025-12-01", to: "2025-12-31" }, "across a year");
  assert.deepEqual(periodRange("3m", "2026-03-04"), { from: "2026-01-01", to: "2026-03-04" });
  assert.deepEqual(periodRange("year", "2026-11-14"), { from: "2026-01-01", to: "2026-11-14" });
  assert.deepEqual(periodRange({ key: "custom", from: "2026-10-19", to: "2026-11-02" }, "2026-11-14"), { from: "2026-10-19", to: "2026-11-02" });
  assert.deepEqual(periodRange(null, "2026-11-14"), { from: "2026-11-01", to: "2026-11-14" }, "nothing: this month");
  assert.equal(periodLabel("3m"), "Last 3 months");
  assert.equal(periodLabel({ key: "custom", from: "2026-11-01", to: "2026-11-17" }), "Nov 1 - 17, 2026");
  assert.equal(periodLabel({ key: "custom", from: "2026-10-19", to: "2026-11-02" }), "Oct 19 - Nov 2, 2026");
  assert.equal(periodLabel({ key: "custom", from: "2025-12-01", to: "2026-01-04" }), "Dec 1, 2025 - Jan 4, 2026");
  assert.match(h(periodChip("month", { name: "inv" })), /^<button type="button" class="rs-pchip" data-period="inv" aria-haspopup="dialog" aria-label="Dates: This month"><span>This month<\/span><svg/);
  const st = h(stepper([["open", "Open"], ["approved", "Approved"], ["paid", "Paid"], ["closed", "Closed"]], "approved", { label: "Pay period" }));
  assert.match(st, /^<ol class="rs-steps" aria-label="Pay period"><li class="rs-step done"><span class="rs-step-d" aria-hidden="true"><svg[\s\S]*Open<\/span><span class="sr">, done<\/span><\/li><li class="rs-step on" aria-current="step"><span class="rs-step-d" aria-hidden="true">2<\/span><span class="rs-step-l">Approved<\/span><\/li><li class="rs-step">/);
  assert.match(h(stickyCta("Call next", { data: { "call-next": true }, icon: "call" })), /^<div class="rs-cta"><button type="button" class="rs-pb red wide" data-call-next=""><svg[\s\S]*<span>Call next<\/span><\/button><\/div>$/);
  assert.match(h(emptyCard({ icon: "money", title: "No payouts yet", text: "Payouts show here once Stripe is connected.", action: { label: "Settings", href: "#/settings/payments" } })), /^<div class="rs-card rs-emptycard"><span class="rs-ci" aria-hidden="true"><svg[\s\S]*<b>No payouts yet<\/b><p class="rs-sub">Payouts show here once Stripe is connected\.<\/p><a href="#\/settings\/payments" class="rs-pb solid">/);
  assert.match(h(seg([["a", "A"], ["b", "B"]], "a", { scroll: true })), /^<div class="rs-seg scroll" role="tablist"\s*>/);
  assert.match(h(dragHandle("q1", "Move Quinn")), /^<button type="button" class="rs-drag" data-drag-handle="q1" aria-label="Move Quinn\. Use the up and down arrows\.">/);
});

test("K0's classes all have their look in crm.css, both themes from the tokens", () => {
  const { tileRow, listRow, listCard, board, boardCard, stepper, stickyCta, emptyCard, periodChip, seg, dragHandle } = ui;
  const out = [
    tileRow([{ key: "a", label: "A", value: 1, tone: "red", money: 1 }, { key: "b", label: "B", info: true }], { big: true, on: "a" }),
    listCard([listRow({ title: "x", amount: 1, sub: "y", tag: "t", pill: "Paid", edge: "red", initials: "XY", action: { icon: "call", label: "c" }, href: "#/x" })]),
    board({ columns: [{ key: "a", label: "A", cards: [boardCard({ title: "x", pill: "New", sub: "y", meta: "z", edge: "red", done: true, move: { data: { m: 1 } }, data: { o: 1 } })] }, { key: "b", label: "B", cards: [] }] }),
    stepper([["a", "A"], ["b", "B"], ["c", "C"]], "b"), stickyCta("Go"), emptyCard({ title: "x", text: "y", action: { label: "z", data: { z: 1 } } }), periodChip("week"), seg([["a", "A"]], "a", { scroll: true }), dragHandle("a"),
  ].map(String).join("");
  const classes = new Set([...out.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const missing = [...classes].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`).test(CSS));
  assert.deepEqual(missing, []);
  for (const c of ["rs-cols", "rs-col-cards", "rs-strip-b", "rs-chip", "rs-chips", "rs-ffoot", "rs-fshow", "rs-where", "sec-more", "tb-bell", "at-home", "subnav.sec"]) assert.match(CSS, new RegExp(`\\.${c.replace(".", "\\.")}\\b`), c);
  assert.match(CSS, /\.rs-col\{flex:0 0 86vw/, "a column is about 86% of a phone");
  assert.match(CSS, /scroll-snap-type:x mandatory/, "columns snap");
  assert.match(CSS, /\.rs-tile\[aria-pressed="true"\]/, "the tile that is on is outlined");
  assert.doesNotMatch(CSS, /\.rs-tile\{[^}]*#[0-9a-f]{6}/i, "tiles use the tokens");
});

test("Polish 3: pageHeader, dataTable (headers, cells by kind, rows that are links or buttons, the empty state, loading), skeletonRows, emptyState", () => {
  const { pageHeader, dataTable, skeletonRows, emptyState, emptyCard, listCard } = ui;
  // the page header: the title, a grey line, one red pill (a link)
  const ph = h(pageHeader({ title: "Invoices", sub: "4 open", action: { label: "New invoice", href: "#/invoices/new" } }));
  assert.match(ph, /^<header class="rs-ph"><div class="rs-ph-t"><h2>Invoices<\/h2><p class="rs-sub">4 open<\/p><\/div><div class="rs-ph-act"><a href="#\/invoices\/new" class="rs-pb red"><svg/);
  assert.equal(h(pageHeader({ title: "Only a title" })), '<header class="rs-ph"><div class="rs-ph-t"><h2>Only a title</h2></div></header>');
  assert.match(h(pageHeader({ title: "x", action: { label: "Go", tone: "solid", icon: null, data: { go: 1 } } })), /<button type="button" class="rs-pb solid" data-go="1"><span>Go<\/span><\/button>/);
  // the table
  const cols = [{ key: "d", label: "Date created", kind: "date" }, { key: "c", label: "Customer", kind: "title" }, { key: "s", label: "Status", kind: "status" }, { key: "a", label: "Amount", kind: "money" }, { key: "x", label: "Tags", width: "120px; color:red" }];
  const t = h(dataTable({ columns: cols, label: "Invoices", rows: [
    { cells: { d: "Nov 12", c: { text: "Pat <Sample>", sub: "INV-1" }, s: "Paid", a: 19500 }, href: "#/invoices/x" },
    { cells: { d: "Nov 13", c: "Robin Workday", s: { label: "Late", tone: "red" }, a: "$5.00", x: "Plan" }, data: { open: "y" }, edge: "red", action: { icon: "chat", label: "Text", data: { remind: "y" } }, hold: { "row-more": "y" } },
    null,
  ] }));
  assert.match(t, /^<div class="rs-card flush rs-table has-act" style="--cols:minmax\(96px,\.8fr\) minmax\(160px,1\.6fr\) minmax\(110px,\.7fr\) minmax\(96px,\.7fr\) minmax\(0,1fr\)">/, "a bad width is refused for the kind's own");
  assert.match(t, /<div class="rs-thead" aria-hidden="true"><div class="rs-tmain"><span class="rs-td c-date">Date created<\/span><span class="rs-td c-title">Customer<\/span><span class="rs-td c-status">Status<\/span><span class="rs-td c-money num">Amount<\/span><span class="rs-td c-text">Tags<\/span><\/div><\/div>/);
  assert.match(t, /<ul class="rs-tlist" aria-label="Invoices"><li class="rs-trow"><a class="rs-tmain" href="#\/invoices\/x"><span class="rs-td c-date">Nov 12<\/span><span class="rs-td c-title"><span class="rs-tt">Pat &lt;Sample&gt;<\/span><span class="rs-ts">INV-1<\/span><\/span><span class="rs-td c-status"><span class="pill green">Paid<\/span><\/span><span class="rs-td c-money num">\$195\.00<\/span><span class="rs-td c-text none"><span class="rs-dash" aria-hidden="true">-<\/span><\/span><\/a><\/li>/);
  assert.match(t, /<li class="rs-trow edge-red" data-hold="" data-row-more="y"><button type="button" class="rs-tmain" data-open="y">[\s\S]*<span class="pill red">Late<\/span>[\s\S]*\$5\.00[\s\S]*<\/button><span class="rs-acts"><button type="button" class="rnd grey sm" aria-label="Text" data-remind="y">/);
  assert.equal((t.match(/class="rs-trow/g) || []).length, 2, "falsy rows skipped");
  // up to 3 round actions (Rotor's ▷ ✓ ⋮): --acts sizes the headers' room; a `wide` one shows only on a wide table
  const t3 = h(dataTable({ columns: cols, rows: [{ cells: { c: "Pat" }, href: "#/jobs/a", action: [{ icon: "play", label: "Start", data: { go: "a" } }, null, { icon: "check", label: "Done", wide: true, data: { done: "a" } }, { icon: "more", label: "More", wide: true, data: { more: "a" } }, { icon: "x", label: "Fourth" }] }] }));
  assert.match(t3, /class="rs-card flush rs-table has-act" style="--cols:[^"]*;--acts:3"/);
  assert.match(t3, /<span class="rs-acts"><button type="button" class="rnd grey sm" aria-label="Start" data-go="a">[\s\S]*<\/button><span class="rs-tact-w"><button type="button" class="rnd grey sm" aria-label="Done" data-done="a">[\s\S]*<span class="rs-tact-w"><button[^>]*aria-label="More"/);
  assert.doesNotMatch(t3, /Fourth/, "three at most");
  assert.doesNotMatch(t, /--acts/, "one action: no --acts");

  assert.throws(() => dataTable({ columns: cols, rows: [{ cells: {}, href: "javascript:alert(1)" }] }), UnsafeHtml);
  // empty: a line, or the empty state under the headers
  assert.match(h(dataTable({ columns: cols, empty: "No invoices yet." })), /<\/div><\/div><p class="rs-empty rs-tempty">No invoices yet\.<\/p><\/div>$/);
  assert.match(h(dataTable({ columns: cols, empty: { icon: "doc", title: "No invoices yet", text: "Bill a customer.", action: { label: "New Invoice", href: "#/invoices/new" } } })), /<div class="rs-emptycard rs-emptystate"><span class="rs-ci" aria-hidden="true"><svg[\s\S]*<b>No invoices yet<\/b><p class="rs-sub">Bill a customer\.<\/p><a href="#\/invoices\/new" class="rs-pb solid">/);
  // loading: the same columns as grey bars, busy
  const ld = h(dataTable({ columns: cols, loading: 3, label: "invoices" }));
  assert.match(ld, /^<div class="rs-card flush rs-table rs-skel" aria-busy="true" aria-label="Loading invoices" style="--cols:/);
  assert.equal((ld.match(/class="rs-trow rs-skrow"/g) || []).length, 3);
  // skeleton rows: two-line bars; not busy inside a busy box; clamped
  const sk = h(skeletonRows(2));
  assert.match(sk, /^<div class="rs-card flush rs-skel" aria-busy="true" aria-label="Loading"><ul class="rs-sklist" aria-hidden="true"><li class="rs-skrow"><span class="sk-lines"><span class="sk w70"><\/span>/);
  assert.equal((sk.match(/class="rs-skrow"/g) || []).length, 2);
  assert.match(h(skeletonRows(3, { busy: false, card: false })), /^<div class="rs-skel"><ul/);
  assert.equal((h(skeletonRows(500)).match(/rs-skrow/g) || []).length, 20);
  // the empty state, in a card or not; listCard takes its options
  assert.match(h(emptyState({ title: "No tasks found", text: "Tasks help." })), /^<div class="rs-emptycard rs-emptystate"><span class="rs-ci" aria-hidden="true"><svg[\s\S]*<b>No tasks found<\/b><p class="rs-sub">Tasks help\.<\/p><\/div>$/);
  assert.match(h(listCard([], { empty: { title: "No invoices yet", text: "x" } })), /^<div class="rs-card rs-emptycard">/);
  assert.match(h(emptyCard({ title: "x", action: { label: "Go", href: "#/x", icon: null } })), /<a href="#\/x" class="rs-pb solid"><span>Go<\/span><\/a>/);
  // every class they draw has its look
  const out = [ph, t, ld, sk, h(emptyState({ title: "x" }))].join("");
  const classes = new Set([...out.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const missing = [...classes].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`).test(CSS));
  assert.deepEqual(missing, []);
  // the table goes from rows to columns by its card's width (a container query), and so do Row2 lists
  assert.match(CSS, /\.rs-table\{container-type:inline-size\}/);
  assert.match(CSS, /\.rs-list\{container-type:inline-size\}/);
  assert.match(CSS, /@container \(min-width:600px\)\{[^@]*\.rs-tmain\{display:grid;grid-template-columns:var\(--cols\)/);
});

