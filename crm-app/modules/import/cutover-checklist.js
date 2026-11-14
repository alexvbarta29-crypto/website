// Switch from Rotor (design §10.9; owners: cutover:run). One page: who is
// in charge, the checklist (green or red; the items only the owner can
// confirm are tick boxes), the preview (what would go out in the first 72
// hours, approved by the owner), the in-flight documents (each list a bulk
// run to test and confirm), the switch (typed SWITCH TO CRM, enabled only
// when every item is green), going back within 48 hours (typed SWITCH BACK
// TO ROTOR) and what was done when. Nothing here touches Rotor: what changes
// Rotor (its automations, the texting number) is done by the owner there and
// ticked here. Refreshed every few seconds while a preview or the switch runs.

import { html, icon, toast, sheet, attrs } from "../../core/ui.js";
import { dateTime, ago } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

const GROUPS = ["Platform", "Accounts", "Content and money", "Claude and Meta", "Public site", "Data", "Preview approved"];
let timer = null;
const stopWatch = () => { if (timer) clearInterval(timer); timer = null; };
const n = (x) => Number(x || 0).toLocaleString("en-US");
const busyNow = (s) => !!s.active || (s.preview && s.preview.status === "running");

export function stateMark(it) {
  if (it.state === "ok") return html`<span class="pill green">Done</span>`;
  if (it.state === "rehearsal") return html`<span class="pill blue">Rehearsal</span>`;
  return html`<span class="pill red">To do</span>`;
}

function itemRow(it) {
  const detail = it.detail ? html`<span class="sub">${it.detail}</span>` : it.ticked ? html`<span class="sub">Ticked ${ago(it.ticked.at)}</span>` : "";
  if (it.kind === "owner") {
    return html`<li class="co-item"><label class="check co-tick"><input ${attrs({ type: "checkbox", "data-tick": it.key, checked: it.state === "ok" })}><span class="who"><span class="nm">${it.label}</span>${detail}</span></label></li>`;
  }
  return html`<li class="co-item"><span class="who"><span class="nm">${it.label}</span>${detail}</span><span class="end">${stateMark(it)}</span></li>`;
}

export function checklistCard(s) {
  const groups = GROUPS.map((g) => ({ g, items: s.items.filter((i) => i.group === g) })).filter((x) => x.items.length);
  const left = s.items.filter((i) => i.state === "todo").length;
  return html`<section class="card">
    <div class="im-head"><h2>Checklist</h2>${left ? html`<span class="pill amber">${left} to do</span>` : html`<span class="pill green">All green</span>`}</div>
    ${s.rehearsal ? html`<p class="small muted">This isn't the production site: items only the real site can check say "Rehearsal".</p>` : ""}
    ${groups.map((x) => html`<div class="section-h">${x.g}</div><ul class="co-list">${x.items.map(itemRow)}</ul>`)}
  </section>`;
}

function totalsLine(t) {
  if (!t) return "";
  return html`<div class="im-tiles"><div class="im-tile"><b>${n(t.texts)}</b><span>texts</span></div><div class="im-tile"><b>${n(t.emails)}</b><span>emails</span></div><div class="im-tile"><b>${n(t.charges)}</b><span>charges</span></div></div>`;
}

export function previewCard(s) {
  const p = s.preview;
  const crm = s.mode.system_of_record === "crm";
  if (crm) return "";
  return html`<section class="card">
    <h2>Preview</h2>
    <p class="small muted">What the CRM would send and charge from the switch to 72 hours after it, per automation and day. Rotor's own texts count as sent, and nothing the import brought in that was done or due before the switch is reminded.</p>
    ${!p ? html`<p>No preview yet. Make it right after the final import.</p>`
      : p.status !== "done" ? html`<p>Working it out… (a minute or two)</p>`
      : html`${totalsLine(p.totals)}
        <p class="small muted im-gap">Made ${ago(p.computed_at || p.created_at)} for a switch at ${dateTime(p.at)}.${p.current ? "" : " It's out of date: make it again."}</p>
        <div class="btn-row"><a class="btn" href="#/cutover/preview">See the counts</a>${p.approved_at ? html`<span class="pill green">Approved ${ago(p.approved_at)}</span>` : p.current ? html`<button type="button" class="btn primary" data-approve>Approve these counts</button>` : ""}</div>`}
    <div class="btn-row"><button type="button" class="btn" data-preview ${attrs({ disabled: !!(p && p.status === "running") })}>${p ? "Make it again" : "Make the preview"}</button></div>
  </section>`;
}

export function inFlightCard(f) {
  if (!f) return "";
  const rows = [["quotes", "Re-send"], ["invoices", "Re-issue"], ["agreements", "Re-request"]];
  return html`<section class="card">
    <h2>Documents in flight</h2>
    <p class="small muted">Quotes Rotor sent in the last 30 days, its open invoices and unsigned agreements: each list goes out as a bulk send pointing the customer to the new portal. You test it and confirm it under Approvals.</p>
    <ul class="co-list">${rows.map(([k, verb]) => {
      const x = f[k] || { count: 0 };
      return html`<li class="co-item"><span class="who"><span class="nm">${x.label || k}</span><span class="sub">${n(x.count)} ${x.count === 1 ? "customer" : "customers"}</span></span>
        <span class="end">${x.bulk_run_id ? html`<a class="btn co-btn" href="#/approvals">Open</a>` : html`<button type="button" class="btn co-btn" ${attrs({ "data-inflight": k, disabled: !x.count })}>${verb}</button>`}</span></li>`;
    })}</ul>
  </section>`;
}

export function switchCard(s) {
  const crm = s.mode.system_of_record === "crm";
  if (crm) {
    const rb = s.rollback || {};
    return html`<section class="card">
      <h2>The CRM is in charge</h2>
      <p>Since ${dateTime(s.mode.cutover_at)}. Texts, emails and charges go out from the CRM for each integration you connected.</p>
      ${rb.allowed ? html`<p class="small muted">Until ${dateTime(rb.until)} you can go back to Rotor: the CRM goes back to report-only, you turn Rotor's automations back on, and what the CRM made since the switch is listed for you to enter in Rotor.</p>
        <div class="btn-row"><button type="button" class="btn danger" data-rollback ${attrs({ disabled: busyNow(s) })}>Switch back to Rotor</button></div>` : html`<p class="small muted">The 48 hours to go back to Rotor are over.</p>`}
    </section>`;
  }
  return html`<section class="card">
    <h2>Switch to the CRM</h2>
    <p>Rotor is in charge${s.mode.cutover_n ? " again" : ""}. The switch sets the next job, invoice and quote numbers after Rotor's, marks Rotor's reminders and receipts as sent, cancels what was waiting in dry-run, and makes the CRM the system of record.</p>
    ${s.ready ? html`<p class="ok-box">Every item is green.</p>` : html`<p class="warn-box">Finish the checklist first.</p>`}
    <div class="btn-row"><button type="button" class="btn primary" data-switch ${attrs({ disabled: !s.ready || busyNow(s) })}>Switch to the CRM</button></div>
  </section>`;
}

function activeCard(s) {
  if (!s.active) return "";
  return html`<section class="card"><h2>${s.active.kind === "rollback" ? "Going back to Rotor" : "Switching"}</h2><p>Working in the background. You can leave this screen.</p></section>`;
}

function listCard(s) {
  if (!s.rollback_list || !s.rollback_list.length) return "";
  const LABEL = { invoice: "Invoice", quote: "Quote", visit: "Visit" };
  return html`<section class="card">
    <h2>To enter in Rotor</h2>
    <p class="small muted">Made in the CRM while it was in charge.</p>
    <ul class="co-list">${s.rollback_list.map((x) => html`<li class="co-item"><span class="who"><span class="nm">${LABEL[x.type] || x.type} ${x.label || ""}</span><span class="sub">${x.date ? x.date + " · " : ""}${dateTime(x.at)}</span></span>
      ${x.contact_id ? html`<a class="btn co-btn" ${attrs({ href: "#/contacts/" + x.contact_id })}>Open</a>` : ""}</li>`)}</ul>
  </section>`;
}

function historyCard(s) {
  if (!s.history || !s.history.length) return "";
  const ST = { done: ["green", "Done"], running: ["blue", "Running"], failed: ["red", "Stopped"] };
  return html`<section class="card"><h2>History</h2><ul class="co-list">${s.history.map((h) => {
    const [cls, label] = ST[h.status] || ["", h.status];
    return html`<li class="co-item"><span class="who"><span class="nm">${h.kind === "rollback" ? "Back to Rotor" : "Switch to the CRM"} #${h.n}</span><span class="sub">${dateTime(h.at)}</span></span><span class="end"><span class="${"pill " + cls}">${label}</span></span></li>`;
  })}</ul></section>`;
}

// The typed confirmation, in a sheet. → the words typed, or null.
export function typedSheet(word, title, text) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title,
      body: html`<form class="form" data-typed><p class="muted">${text}</p><label class="field"><span>Type ${word} to confirm</span><input ${attrs({ name: "word", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" })}></label><button type="submit" class="btn danger block">${title}</button></form>`,
      onClose: () => { if (!answered) resolve(null); },
      events: { "submit [data-typed]": (e, f) => { e.preventDefault(); answered = true; resolve(String(f.querySelector("[name=word]").value || "").trim()); s.close(); } },
    });
  });
}

async function loadAll(ctx) {
  const [c, f] = await Promise.all([ctx.api("/cutover", { cache: false }), ctx.api("/cutover/in-flight", { cache: false }).then((x) => x.data).catch(() => null)]);
  return { ...c.data, in_flight: f };
}

export default {
  title: "Switch from Rotor",
  async load(params, ctx) {
    ensureStyles();
    return loadAll(ctx);
  },
  render(s) {
    return html`<div class="stack">
      <section class="card">
        <div class="im-head"><h2>${s.mode.system_of_record === "crm" ? "The CRM is in charge" : "Rotor is in charge"}</h2><a class="btn co-btn" href="#/cutover/runbook">${icon("list")}Runbook</a></div>
        <p class="small muted">Nothing here changes Rotor. What has to change in Rotor (its automations, the texting number, cancelling it) you do there and tick here.</p>
      </section>
      ${activeCard(s)}
      ${s.mode.system_of_record === "crm" ? html`${switchCard(s)}${historyCard(s)}` : html`${checklistCard(s)}${previewCard(s)}${inFlightCard(s.in_flight)}${listCard(s)}${switchCard(s)}${historyCard(s)}`}
    </div>`;
  },
  mount(v, s, ctx) {
    stopWatch();
    if (!busyNow(s)) return;
    timer = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const next = await loadAll(ctx);
        ctx.state = next;
        ctx.rerender();
        if (!busyNow(next)) stopWatch();
      } catch (e) { /* the next tick tries again */ }
    }, 4000);
  },
  unmount() { stopWatch(); },
  events: {
    "change [data-tick]": async (e, el, ctx) => {
      el.disabled = true;
      try {
        const r = await ctx.api("/cutover/ticks", { method: "POST", body: { key: el.dataset.tick, done: el.checked } });
        ctx.state = { ...r.data, in_flight: ctx.state.in_flight };
        ctx.rerender();
      } catch (err) { toast(err.message, { bad: true }); ctx.refresh(); }
    },
    "click [data-preview]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api("/cutover/preview", { method: "POST", body: {} }); toast("Working it out"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-approve]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api("/cutover/approve-preview", { method: "POST", body: {} }); toast("Approved"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-inflight]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/cutover/in-flight/${encodeURIComponent(el.dataset.inflight)}`, { method: "POST", body: {} }); toast("Ready to test under Approvals"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-switch]": async (e, el, ctx) => {
      const w = await typedSheet(ctx.state.confirm.switch, "Switch to the CRM", "From now on the CRM sends the texts, emails and charges. Do this right after you switched off Rotor's automations.");
      if (w === null) return;
      el.disabled = true;
      try { await ctx.api("/cutover/run", { method: "POST", body: { confirm: w } }); toast("Switching"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-rollback]": async (e, el, ctx) => {
      const w = await typedSheet(ctx.state.confirm.rollback, "Switch back to Rotor", "The CRM goes back to report-only. Then turn Rotor's automations back on.");
      if (w === null) return;
      el.disabled = true;
      try { await ctx.api("/cutover/rollback", { method: "POST", body: { confirm: w } }); toast("Going back"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
