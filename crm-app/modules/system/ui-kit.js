// #/kit: every piece of the Rotor-style kit on one page (Nov 2026; owners
// and the office only, in no menu), so the screen tracks can check how a
// piece looks in both themes before they use it. Light · Dark at the top
// previews a theme on this page only (this device's own choice comes back
// when you leave). The header shows the kit's own contract: a round
// pencil, a round share and the round "..." with its action sheet. Made-up
// people from the test seed only; nothing here reads or writes data.

import {
  html, icon, toast, rnd, statusPill, pillTap, pillBtn, seg, cardHead, sectionLabel, statGrid, contactRows,
  personCard, addressCard, lineItems, notesBox, disclosure, formRow, formRows, toggle, quickRow, actionSheet, sheetPage,
  tileRow, tileToggle, listRow, listCard, board, boardCard, boardMount, moveSheet, filterSheet, periodChip, periodSheet,
  stepper, stickyCta, emptyCard, dragList, dragHandle, pageHeader, dataTable, skeletonRows, emptyState,
} from "../../core/ui.js";
import { applyTheme } from "../../core/nav.js";

const PILLS = ["Booked", "Sent", "Active", "Paid", "Signed", "To book", "Pending", "Overdue", "Lost", "Draft", "Medium", "High priority"];
const SAY = (what) => toast(`${what} (the kit only shows it)`);

// The list and board patterns (K0): made-up people, nothing read or written.
const INVOICES = [
  { id: "a", name: "Quinn Talkedto", no: "INV-100201", due: "due Nov 13", cents: 22500, st: "Overdue" },
  { id: "b", name: "Robin Workday", no: "INV-100202", due: "due Nov 20", cents: 35500, st: "Sent", tag: "Plan" },
  { id: "c", name: "Jamie Example", no: "INV-100203", due: "paid Nov 10", cents: 19500, st: "Paid" },
  { id: "d", name: "Pat Sample", no: "INV-100204", due: "draft", cents: 16000, st: "Draft" },
];
// the table (Polish 3): the customer and the number, due, the plan tag, the status, the amount
const TABLE_COLS = [{ key: "name", label: "Customer", kind: "title" }, { key: "due", label: "Due", kind: "date" }, { key: "plan", label: "Billed by" }, { key: "st", label: "Status", kind: "status" }, { key: "amt", label: "Amount", kind: "money" }];
const STAGES = [["new", "New"], ["contacted", "Contacted"], ["quoted", "Quoted"], ["follow_up", "Follow-Up"], ["sold", "Sold"]];
const CARDS = [
  { id: "l1", name: "Avery Newlead", stage: "new", src: "Website · $0", meta: "Created Nov 14 · Follow-up Nov 16", pri: "High" },
  { id: "l2", name: "Casey Caller", stage: "new", src: "Referral · $450", meta: "Created Nov 12 · Last contact Nov 13" },
  { id: "l3", name: "Quinn Talkedto", stage: "contacted", src: "Door to door · $195", meta: "Created Nov 10 · Follow-up Nov 18" },
  { id: "l4", name: "Drew Quoted", stage: "quoted", src: "Website · $780", meta: "Quote viewed 2 h ago", overdue: true },
];
const FILTERS = [
  { key: "status", label: "Status", type: "chips", options: [["overdue", "Overdue"], ["sent", "Sent"], ["paid", "Paid"], ["draft", "Draft"]] },
  { key: "plan", label: "Billed by a plan", type: "toggle", text: "Only plan invoices" },
  { key: "period", label: "Created", type: "period" },
  { key: "sort", label: "Sort", type: "sort", default: "due", options: [["due", "Due date"], ["total", "Total"], ["name", "Name"]] },
];

// the "..." of this page: what a lead's sheet would hold, red rows last
function moreGroups() {
  return [
    [{ label: "Log a call", icon: "call", run: () => SAY("Log a call") }, { label: "Start a follow-up", icon: "flag", run: () => SAY("Start a follow-up") }, { label: "New task", icon: "check", run: () => SAY("New task") }],
    [{ label: "New quote", icon: "doc", run: () => SAY("New quote") }, { label: "New invoice", icon: "money", hint: "Add credit, card link", run: () => SAY("New invoice") }],
    [{ label: "Archive", icon: "trash", danger: true, data: { "kit-archive": true }, run: () => SAY("Archive") }, { label: "Edit lead", icon: "edit", run: () => SAY("Edit lead") }, { label: "Merge with...", icon: "merge", disabled: true }],
  ];
}

function openPage() {
  sheetPage({
    title: "Service plan",
    seg: { items: [["service", "Service"], ["agree", "Agree"], ["schedule", "Schedule"]], on: "service", black: true },
    panes: {
      service: html`${sectionLabel("Details")}${formRows([
        formRow("Frequency", html`<select name="freq" aria-label="Frequency"><option>Quarterly</option><option>Biannual</option><option>Monthly</option></select>`),
        formRow("Start date", html`<input type="date" name="start" value="2026-11-17" aria-label="Start date">`),
        formRow("Renews", toggle(true, { data: { "kit-switch": true }, label: "Renews" })),
      ])}${sectionLabel("Pricing")}<div class="rs-card">${lineItems([{ title: "Exterior window cleaning", qty: 1, unit: 19500, amount: 19500 }], { addItem: { data: { "kit-tap": "Item" } }, addDiscount: { data: { "kit-tap": "Add discount" } }, total: 19500 })}</div>`,
      agree: html`<div class="rs-card"><div class="rs-row"><b>Service Agreement</b>${statusPill("Not signed")}</div><p class="rs-sub">Created Nov 17</p></div>${pillBtn("Send the agreement", { tone: "red", wide: true, data: { "kit-tap": "Send the agreement" } })}`,
      schedule: html`<div class="rs-card rs-dashed"><div class="rs-row"><b>March 2027</b>${statusPill("Pending")}</div><p class="rs-sub">$195.00</p></div>`,
    },
    done: { label: "Save", run: () => { toast("Saved (the kit only shows it)"); } },
    events: {
      "click [data-kit-tap]": (e, el) => SAY(el.dataset.kitTap),
      "click [data-kit-switch]": (e, el) => el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true"),
    },
  });
}

export default {
  title: "Kit",
  load(params, ctx) {
    return {
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark", tab: ctx.keep.tab || "details", view: "service", auto: true,
      mk: "workflows", tile: "all", period: "month", col: "new", cards: CARDS.map((c) => ({ ...c })), order: ["Avery Newlead", "Casey Caller", "Quinn Talkedto"], filter: {},
    };
  },
  tools: () => [{ icon: "edit", label: "Edit", run: () => SAY("Edit") }, { icon: "share", label: "Share", run: () => SAY("Share") }],
  more: () => moreGroups(),
  moreTitle: () => "Quinn Talkedto",
  render(s) {
    const tap = (what) => ({ "kit-tap": what });
    return html`<div class="rs-page kit-page">
      ${seg([["light", "Light"], ["dark", "Dark"]], s.theme, { name: "theme", label: "Theme on this page" })}

      ${sectionLabel("Name, pills, segmented")}
      <div class="rs-name"><h2>Quinn Talkedto</h2>${statusPill("Quoted", "orange")}</div>
      <div class="rs-pills">${pillTap("Olive Owner", { icon: "user", data: tap("Pick an owner"), aria: "Owner: Olive Owner. Change" })}${statusPill("Lead since Nov 17", "white")}</div>
      ${seg([["details", "Details"], ["activity", "Activity"]], s.tab, { name: "tab", label: "Lead" })}
      ${seg([{ key: "service", label: "Service" }, { key: "agree", label: "Agree" }, { key: "schedule", label: "Schedule", count: 4 }], s.view, { name: "view", black: true, label: "Plan" })}
      <div class="rs-pills">${PILLS.map((p) => statusPill(p))}</div>

      ${sectionLabel("Stat card")}
      ${statGrid([{ label: "Stage", value: "Estimate sent", data: tap("Open the deal") }, { label: "Follow up", value: "Wed, Nov 18" }, { label: "Value", value: "$195" }, { label: "Source", value: "Website quote form", wide: true }, { label: "Next visit", value: "" }, { label: "Balance", value: "$160.00", tone: "red" }], { label: "Lead details" })}

      ${sectionLabel("Contact")}
      ${contactRows([
        { icon: "call", label: "Mobile", value: "(763) 555-1903", actions: [{ icon: "chat", label: "Text", data: tap("Text") }, { icon: "call", label: "Call", tone: "red", href: "tel:+17635551903" }] },
        { icon: "mail", label: "Email", value: "quinn.talkedto@example.com", href: "mailto:quinn.talkedto@example.com", actions: [{ icon: "copy", label: "Copy the email", data: tap("Copied") }] },
        { icon: "pin", label: "Address", value: "303 Example Ave, Delano, MN 55328", actions: [{ icon: "nav", label: "Directions", data: tap("Directions") }] },
      ])}
      <div class="rs-sat" aria-label="Satellite (the contact page paints it)" role="img"></div>

      ${sectionLabel("Person and address")}
      ${personCard({ name: "Robin Workday", sub: "(763) 555-1800", href: "#/kit", call: "tel:+17635551800", text: { data: tap("Text Robin") } })}
      ${addressCard({ line1: "700 Example Ave", line2: "Delano, MN 55328 · gate 1234", nav: { data: tap("Directions") }, edit: { label: "Edit access", data: tap("Edit access") } })}

      ${sectionLabel("Round buttons")}
      <div class="rs-card"><div class="rs-row kit-rnds">
        ${rnd("back", "Back", { data: tap("Back") })}${rnd("edit", "Edit", { data: tap("Edit") })}${rnd("more", "More", { data: tap("More") })}${rnd("plus", "New", { tone: "coral", data: tap("New") })}${rnd("call", "Call", { tone: "red", data: tap("Call") })}${rnd("search", "Search", { tone: "solid", data: tap("Search") })}
      </div><div class="rs-row kit-rnds">
        ${rnd("plus", "Add", { tone: "grey", sm: true, data: tap("Add") })}${rnd("edit", "Edit", { tone: "grey", sm: true, data: tap("Edit") })}${rnd("chat", "Text", { tone: "grey", sm: true, data: tap("Text") })}${rnd("call", "Call", { tone: "red", sm: true, data: tap("Call") })}${rnd("copy", "Copy", { sm: true, data: tap("Copy") })}${rnd("inbox", "Inbox", { sm: true, badge: 3, data: tap("Inbox") })}
      </div></div>
      ${quickRow([{ icon: "call", label: "Call", data: tap("Call") }, { icon: "nav", label: "Navigate", data: tap("Navigate") }, { icon: "camera", label: "Photos", badge: 2, data: tap("Photos") }, { icon: "check", label: "Checklist", data: tap("Checklist") }])}

      ${sectionLabel("Top card")}
      <div class="rs-card">
        <div class="rs-row"><span class="rs-pills">${statusPill("Booked")}${statusPill("Not invoiced")}</span><span class="rs-sub">Nov 17, 8:00 AM</span></div>
        <p class="kit-p">Exterior window cleaning + Screens</p>
        <div class="rs-kv"><span>Total</span><span class="rs-amt">$355.00</span></div>
        <a class="rs-inset" href="#/kit"><span>Invoice SINV-0003 · Paid · $355.00</span><span class="chev" aria-hidden="true"></span></a>
      </div>
      <div class="rs-card rs-row"><span class="rs-ci" aria-hidden="true">${icon("cal")}</span><span class="kit-grow"><b>Visit · Tue, Nov 17</b><br><span class="rs-sub">8:00 - 10:00 AM · Theo Tech</span></span>${pillBtn("Visit", { icon: "plus", tone: "solid", data: tap("+ Visit") })}</div>

      ${sectionLabel("Cards with + and pencil")}
      <div class="rs-card">${cardHead("Quotes", { add: { label: "New quote", data: tap("New quote") }, count: "1 quote" })}
        ${lineItems([{ title: "SQ-0002 · Windows inside and out", sub: "Sent just now · good through Dec 17", amount: 19500 }])}</div>
      <div class="rs-card">${cardHead("Tasks", { add: { label: "New task", data: tap("New task") } })}<p class="rs-empty">No tasks yet</p></div>
      <div class="rs-card">${cardHead("Notes for the crew", { edit: { label: "Edit the notes", data: tap("Edit the notes") } })}${notesBox("Synthetic: dog in the back yard.", { name: "crew", label: "Notes for the crew", placeholder: "Add notes for this job..." })}</div>

      ${sectionLabel("Pricing")}
      <div class="rs-card">${cardHead("Pricing")}${lineItems(
        [{ title: "Exterior window cleaning", qty: 1, unit: 29500, amount: 29500, data: tap("Edit the line") }, { title: "Screens", qty: 12, unit: 500, amount: 6000 }],
        { addItem: { data: tap("+ Item") }, subtotal: 35500, discounts: [{ label: "Plan discount", amount: -3550 }], addDiscount: { data: tap("+ Add discount") }, total: 31950, cta: { label: "Create Invoice", data: tap("Create Invoice") } },
      )}</div>
      <div class="rs-card">${lineItems([{ title: "Gutter cleaning", qty: 1, unit: 16000, amount: 16000 }], { total: 16000, totalLabel: "Balance due", paid: "Paid Jun 24" })}</div>

      ${sectionLabel("Rows")}
      ${disclosure("Sold by", { value: "Olive Owner", data: tap("Sold by") })}
      ${disclosure("Activity", { sub: "changed just now", href: "#/kit" })}
      <div class="rs-card rs-dashed"><div class="rs-row"><b>To book (6)</b>${pillBtn("Schedule", { tone: "solid", data: tap("Schedule") })}</div></div>
      ${formRows([formRow("Auto-Pay", toggle(s.auto, { data: { "kit-auto": true }, label: "Auto-Pay" }), { hint: "Visa ending 4242" }), formRow("Billing", html`<select name="billing" aria-label="Billing"><option>When each visit is done</option><option>The 1st of the month</option></select>`)])}

      ${sectionLabel("Lists and boards (K0)")}
      ${seg(["Workflows", "Campaigns", "Reviews", "Referrals", "Forms", "Templates"].map((l) => [l.toLowerCase(), l]), s.mk, { name: "mk", label: "Marketing", scroll: true })}
      ${tileRow([
        { key: "all", label: "All", value: INVOICES.length },
        { key: "overdue", label: "Overdue", value: 1, money: 22500, tone: "red" },
        { key: "sent", label: "Sent", value: 1, money: 35500 },
        { key: "paid", label: "Paid", value: 1, money: 19500 },
        { key: "draft", label: "Draft", value: 1 },
        { key: "arr", label: "ARR", value: "$12,480", info: true },
      ], { name: "kit", on: s.tile, label: "Invoices" })}
      <div class="rs-row kit-rnds">${periodChip(s.period, { name: "kit" })}${pillBtn("Filter", { icon: "filter", data: { "kit-filter": true } })}</div>
      ${listCard(INVOICES.filter((x) => s.tile === "all" || x.st.toLowerCase() === s.tile).map((x) => listRow({
        title: x.name, amount: x.cents, sub: `${x.no} · ${x.due}`, tag: x.tag || null, pill: x.st, href: "#/kit", edge: x.st === "Overdue" ? "red" : null,
        action: x.st === "Overdue" ? { icon: "chat", label: `Text ${x.name} a reminder`, data: tap("Text a reminder") } : null, hold: { "kit-row": x.id },
      })), { label: "Invoices", empty: "No invoices match." })}
      ${board({ name: "kit", label: "Leads", on: s.col, columns: STAGES.map(([k, l]) => ({ key: k, label: l, cards: s.cards.filter((c) => c.stage === k).map((c) => boardCard({
        title: c.name, pill: c.pri ? statusPill(c.pri) : null, sub: c.src, meta: c.meta, edge: c.overdue ? "red" : null, href: "#/kit",
        move: { data: { "kit-move": c.id } }, action: { icon: "call", label: `Call ${c.name}`, tone: "red", data: tap("Call") }, hold: { "kit-card": c.id },
      })) })) })}
      <div class="rs-card">${stepper([["open", "Open"], ["approved", "Approved"], ["paid", "Paid"], ["closed", "Closed"]], "approved", { label: "Pay period" })}</div>
      ${emptyCard({ icon: "money", title: "No payouts yet", text: "Payouts show here once Stripe is connected (Settings › Payments).", action: { label: "Payments settings", data: tap("Payments settings"), icon: "gear" } })}
      <ul class="rs-card flush rs-list" data-kit-drag aria-label="Queue">${s.order.map((k) => html`<li class="rs-lrow" data-drag-key="${k}"><span class="rs-lr-main"><span class="rs-lr-a"><span class="rs-lr-1"><span class="rs-lr-t">${k}</span></span></span></span>${dragHandle(k, "Move " + k)}</li>`)}</ul>
      <div class="kit-cta">${stickyCta("Approve period", { data: tap("Approve period"), icon: "check" })}</div>

      ${sectionLabel("Pages and tables (Polish 3)")}
      ${pageHeader({ title: "Invoices", sub: "4 invoices, 1 overdue", action: { label: "New invoice", data: tap("New invoice") } })}
      <div class="rs-row kit-rnds">${pillBtn(s.tload ? "Show the rows" : "Show loading", { data: { "kit-tload": true } })}</div>
      ${dataTable({ columns: TABLE_COLS, label: "Invoices", loading: s.tload ? 4 : 0, rows: INVOICES.map((x) => ({
        cells: { name: { text: x.name, sub: x.no }, due: x.due, plan: x.tag || "", st: x.st, amt: x.cents },
        data: tap(`Open ${x.name}`), edge: x.st === "Overdue" ? "red" : null, hold: { "kit-trow": x.id },
        action: x.st === "Overdue" ? { icon: "chat", label: `Text ${x.name} a reminder`, data: tap("Text a reminder") } : null,
      })) })}
      ${dataTable({ columns: TABLE_COLS, label: "Payouts", empty: { icon: "doc", title: "No invoices yet", text: "Bill a customer and let them pay by card or bank, online.", action: { label: "New Invoice", data: tap("New invoice") } } })}
      ${emptyState({ icon: "check", title: "No tasks found", text: "Tasks help your team stay organized." })}
      ${skeletonRows(3, { busy: false })}

      ${sectionLabel("Sheets")}
      <div class="rs-row">${pillBtn("Action sheet", { icon: "more", data: { "kit-actions": true } })}${pillBtn("Sheet page", { icon: "doc", tone: "solid", data: { "kit-page": true } })}</div>

      ${sectionLabel("The floating bar (Track A's shell)")}
      <div class="rs-bar-demo" role="img" aria-label="The floating tab bar and the red +"><div class="bar">${[["home", 7], ["schedule", 0], ["inbox", 2], ["map", 0], ["menu", 0]].map(([k, n], i) => html`<span class="${"bt" + (i === 1 ? " on" : "")}">${icon(k)}${n ? html`<span class="badge">${String(n)}</span>` : ""}</span>`)}</div><span class="fabx">${icon("plus")}</span></div>
    </div>`;
  },
  events: {
    "click [data-seg=theme]": (e, el, ctx) => { ctx.state.theme = el.dataset.key; document.documentElement.dataset.theme = el.dataset.key; ctx.rerender(); },
    "click [data-seg=tab]": (e, el, ctx) => { ctx.state.tab = ctx.keep.tab = el.dataset.key; ctx.rerender(); },
    "click [data-seg=view]": (e, el, ctx) => { ctx.state.view = el.dataset.key; ctx.rerender(); },
    "click [data-kit-auto]": (e, el, ctx) => { ctx.state.auto = !ctx.state.auto; ctx.rerender(); },
    "click [data-kit-tap]": (e, el) => SAY(el.dataset.kitTap),
    "click [data-kit-tload]": (e, el, ctx) => { ctx.state.tload = !ctx.state.tload; ctx.rerender(); },
    "change [data-notes]": () => toast("Notes saved (the kit only shows it)"),
    "click [data-kit-actions]": () => actionSheet("Job S-000001", [[{ label: "Book a visit", icon: "cal", run: () => SAY("Book a visit") }, { label: "Mark done", icon: "check", run: () => SAY("Mark done") }], [{ label: "Cancel job", icon: "close", danger: true, run: () => SAY("Cancel job") }, { label: "Open customer", icon: "user", href: "#/kit" }]]),
    "click [data-kit-page]": () => openPage(),
    "click [data-seg=mk]": (e, el, ctx) => { ctx.state.mk = el.dataset.key; ctx.rerender(); },
    "click [data-tile=kit]": (e, el, ctx) => { ctx.state.tile = tileToggle(ctx.state.tile, el.dataset.key, "all"); ctx.rerender(); },
    "click [data-period=kit]": async (e, el, ctx) => { const p = await periodSheet(ctx.state.period); if (p) { ctx.state.period = p.key === "custom" ? p : p.key; ctx.rerender(); } },
    "click [data-kit-filter]": async (e, el, ctx) => {
      const v = await filterSheet({ title: "Filter invoices", groups: FILTERS, values: ctx.state.filter, count: (x) => INVOICES.filter((i) => !(x.status || []).length || x.status.includes(i.st.toLowerCase())).length });
      if (v) { ctx.state.filter = v; SAY("Filter applied"); }
    },
    "click [data-kit-move]": async (e, el, ctx) => {
      const c = ctx.state.cards.find((x) => x.id === el.dataset.kitMove);
      const to = c && await moveSheet(`Move ${c.name}`, STAGES.map(([k, l]) => ({ key: k, label: l, count: ctx.state.cards.filter((x) => x.stage === k).length })), c.stage);
      if (to) { c.stage = to; ctx.state.col = to; ctx.rerender(); toast(`${c.name} moved`); }
    },
    "rs-hold [data-kit-row]": (e, el) => actionSheet("Invoice", [[{ label: "Text a reminder", icon: "chat", run: () => SAY("Text a reminder") }, { label: "Open customer", icon: "user", run: () => SAY("Open customer") }], [{ label: "Void", icon: "close", danger: true, run: () => SAY("Void") }]]),
    "rs-hold [data-kit-trow]": (e, el) => actionSheet("Invoice", [[{ label: "Text a reminder", icon: "chat", run: () => SAY("Text a reminder") }, { label: "Open customer", icon: "user", run: () => SAY("Open customer") }], [{ label: "Void", icon: "close", danger: true, run: () => SAY("Void") }]]),
    "rs-hold [data-kit-card]": (e, el, ctx) => { const c = ctx.state.cards.find((x) => x.id === el.dataset.kitCard); if (c) actionSheet(c.name, [[{ label: "Move to...", icon: "swap", run: () => el.querySelector("[data-kit-move]").click() }, { label: "Call", icon: "call", run: () => SAY("Call") }]]); },
  },
  mount(view, s, ctx) {
    boardMount(view);
    if (this._stop) this._stop();
    this._stop = dragList(view.querySelector("[data-kit-drag]"), (order) => { s.order = order; toast("New order kept (the kit only shows it)"); });
  },
  // the theme came back to this device's own choice
  unmount() { applyTheme(); if (this._stop) { this._stop(); this._stop = null; } },
};
