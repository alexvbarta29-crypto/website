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
} from "../../core/ui.js";
import { applyTheme } from "../../core/nav.js";

const PILLS = ["Booked", "Sent", "Active", "Paid", "Signed", "To book", "Pending", "Overdue", "Lost", "Draft", "Medium", "High priority"];
const SAY = (what) => toast(`${what} (the kit only shows it)`);

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
    return { theme: document.documentElement.dataset.theme === "light" ? "light" : "dark", tab: ctx.keep.tab || "details", view: "service", auto: true };
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
    "change [data-notes]": () => toast("Notes saved (the kit only shows it)"),
    "click [data-kit-actions]": () => actionSheet("Job S-000001", [[{ label: "Book a visit", icon: "cal", run: () => SAY("Book a visit") }, { label: "Mark done", icon: "check", run: () => SAY("Mark done") }], [{ label: "Cancel job", icon: "close", danger: true, run: () => SAY("Cancel job") }, { label: "Open customer", icon: "user", href: "#/kit" }]]),
    "click [data-kit-page]": () => openPage(),
  },
  // the theme came back to this device's own choice
  unmount() { applyTheme(); },
};
