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
  for (const c of ["ctb-list", "ctb-row", "ctb-div", "ctb-drag", "drawer", "dr-row", "dr-grp", "top-bar", "set-ic", "rs-actions", "rs-act", "rs-act-g", "rs-sheetpage", "rs-done", "rs-sp-pane", "rs-top", "rs-shell", "rs-dashed", "rs-sat", "rs-page", "rs-name", "rs-amt", "rs-inset"]) assert.match(CSS, new RegExp(`\\.${c}\\b`), c);
  // the tokens: light Rotor's, dark ours, under the same names
  assert.match(CSS, /:root\{[^}]*--mist:#f2f2f7;[^}]*--card:#fff;--card-2:#f2f2f7;/);
  assert.match(CSS, /--seg-track:#e3e3e8;/);
  assert.match(CSS, /--card:#1b1c1f;--card-2:#232428;/);
  assert.match(CSS, /--seg-track:#1d1e21;--seg-on:#48494d;/);
});
