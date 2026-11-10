// Approvals (design §9.2 "Approvals", §6.9, §5.7.4, §2.5): what waits for
// an owner's or the office's OK.
//   - Bulk sends (a send to more than a handful of people): the preview
//     (how many, who is left out and why, sample texts), then a required
//     test send to the test contact, then Confirm. Never straight out.
//   - Pending actions (owners): a phone's offline work older than 6 days,
//     and later Claude's requests through an API key, approved or rejected
//     with one tap; an approved action runs once, as the approver.
// The modules add their own rows (late-cancel fees, time entries...) on
// Today's Approvals card as they ship.

import { html, icon, sheet, toast, confirmSheet } from "../../core/ui.js";
import { ago, plural, dateTime } from "../../core/format.js";
import { reasonLabel } from "./kit.js";

const BULK_STATUS = { draft: ["amber", "Preparing"], ready: ["amber", "Needs a test"], tested: ["blue", "Ready to confirm"], sending: ["blue", "Sending"], sent: ["green", "Sent"], cancelled: ["", "Cancelled"], failed: ["red", "Failed"] };

async function bulkSheet(id, ctx) {
  let b;
  try { b = (await ctx.api(`/bulk-runs/${encodeURIComponent(id)}`, { cache: false })).data; } catch (e) { toast(e.message, { bad: true }); return; }
  const p = b.preview;
  const [cls, label] = BULK_STATUS[b.status] || ["", b.status];
  const s = sheet({
    title: b.title,
    body: html`<div class="stack">
      <p><span class="pill ${cls}">${label}</span> <span class="small muted">${b.channel === "sms" ? "Texts" : "Emails"} · ${b.category}</span></p>
      ${p ? html`<div class="card"><h2>${plural(p.count, "person", "people")} will get it</h2>
        ${Object.keys(p.excluded || {}).length ? html`<p class="small">Left out: ${Object.entries(p.excluded).map(([k, n]) => `${n} ${reasonLabel(k)}`).join(" · ")}</p>` : ""}
        ${(p.samples || []).slice(0, 3).map((x) => html`<div class="bubble" style="margin-top:8px">${x.text}</div>`)}</div>` : html`<p class="muted">The preview is being prepared. Check back in a moment.</p>`}
      ${b.test ? html`<div class="ok-box">Test sent ${ago(b.test.sent_at)}${b.test.mode === "dry_run" ? " (to the outbox: texts aren't switched on yet)" : ""}. Check it, then confirm.</div>` : ""}
      ${b.stats && b.stats.recipients ? html`<p class="small">Done: ${b.stats.sent || 0} sent, ${b.stats.dry_run || 0} to the outbox, ${b.stats.failed || 0} failed.</p>` : ""}
      <div class="btn-row">
        ${["ready", "tested"].includes(b.status) ? html`<button type="button" class="btn dark" data-test>${b.test ? "Send the test again" : "Send the test"}</button>` : ""}
        ${b.status === "tested" ? html`<button type="button" class="btn primary" data-confirm>Confirm and send</button>` : ""}
        ${["draft", "ready", "tested", "sending"].includes(b.status) ? html`<button type="button" class="btn danger" data-cancel>Cancel</button>` : ""}
      </div>
    </div>`,
    events: {
      "click [data-test]": async (e, el) => {
        el.disabled = true;
        try { await ctx.api(`/bulk-runs/${encodeURIComponent(id)}/test`, { method: "POST", body: {} }); toast("Test sent"); s.close(); bulkSheet(id, ctx); } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
      },
      "click [data-confirm]": async () => {
        if (!(await confirmSheet(`It goes to ${p ? plural(p.count, "person", "people") : "everyone on the list"}, a few a second.`, { title: "Send it now?", yes: "Send" }))) return;
        try { await ctx.api(`/bulk-runs/${encodeURIComponent(id)}/confirm`, { method: "POST", body: {} }); toast("Sending"); s.close(); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
      },
      "click [data-cancel]": async () => {
        if (!(await confirmSheet("Nobody else gets it. Those already sent stay sent.", { title: "Cancel this send?", yes: "Cancel it", no: "Keep it", danger: true }))) return;
        try { await ctx.api(`/bulk-runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }); toast("Cancelled"); s.close(); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
      },
    },
  });
}

async function pendingSheet(id, ctx) {
  let a;
  try { a = (await ctx.api(`/pending-actions/${encodeURIComponent(id)}`, { cache: false })).data; } catch (e) { toast(e.message, { bad: true }); return; }
  const s = sheet({
    title: a.title,
    body: html`<div class="stack">
      <p class="small muted">Asked ${ago(a.created_at)} · runs out ${dateTime(a.expires_at)}</p>
      ${a.preview && a.preview.rendered_text ? html`<div class="bubble">${a.preview.rendered_text}</div>` : ""}
      ${Array.isArray(a.item_list) ? html`<ul class="list">${a.item_list.map((i) => html`<li><div class="row"><span class="who"><span class="nm mono">${i.method} ${i.path}</span><span class="sub">Made offline ${i.client_at ? dateTime(i.client_at) : ""}</span></span></div></li>`)}</ul><p class="small">These waited on a phone with no signal for more than 6 days. Re-enter what still matters, then mark them reviewed.</p>` : ""}
      ${a.status === "pending" ? html`<div class="btn-row"><button type="button" class="btn danger" data-decide="reject">Reject</button><button type="button" class="btn primary" data-decide="approve">${Array.isArray(a.item_list) ? "Mark reviewed" : "Approve"}</button></div>` : html`<p><span class="pill">${a.status}</span></p>`}
    </div>`,
    events: {
      "click [data-decide]": async (e, el) => {
        el.disabled = true;
        try { await ctx.api(`/pending-actions/${encodeURIComponent(id)}/${el.getAttribute("data-decide")}`, { method: "POST", body: {} }); toast(el.getAttribute("data-decide") === "approve" ? "Approved" : "Rejected"); s.close(); ctx.refresh(); } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
      },
    },
  });
}

export default {
  title: "Approvals",
  async load(params, ctx) {
    const [bulk, pending] = await Promise.all([
      ctx.api("/bulk-runs", { cache: false }).then((r) => r.data || []).catch(() => []),
      ctx.can("pending_actions:approve") ? ctx.api("/pending-actions", { cache: false }).then((r) => r.data || []).catch(() => []) : [],
    ]);
    return { bulk, pending, canApprove: ctx.can("pending_actions:approve") };
  },
  render(s) {
    const waiting = s.bulk.filter((b) => ["draft", "ready", "tested"].includes(b.status));
    const recent = s.bulk.filter((b) => !["draft", "ready", "tested"].includes(b.status)).slice(0, 10);
    const bulkRow = (b) => { const [cls, label] = BULK_STATUS[b.status] || ["", b.status]; return html`<li><button type="button" class="row" data-bulk="${b.id}"><span class="ico ${b.status === "tested" ? "coral" : ""}">${icon("send")}</span><span class="who"><span class="nm">${b.title}</span><span class="sub">${plural(b.recipients, "person", "people")} · ${ago(b.created_at)}</span></span><span class="end"><span class="pill ${cls}">${label}</span><span class="chev" aria-hidden="true"></span></span></button></li>`; };
    return html`<div class="stack">
      <div class="section-h">Bulk sends</div>
      ${waiting.length ? html`<ul class="list">${waiting.map(bulkRow)}</ul>` : html`<div class="card muted small">Nothing waiting. A send to more than a handful of people stops here for a test and your OK.</div>`}
      ${s.canApprove ? html`<div class="section-h">Waiting for an owner</div>
        ${s.pending.length ? html`<ul class="list">${s.pending.map((a) => html`<li><button type="button" class="row" data-pending="${a.id}"><span class="ico coral">${icon("check")}</span><span class="who"><span class="nm">${a.title}</span><span class="sub">${ago(a.created_at)}</span></span><span class="end"><span class="chev" aria-hidden="true"></span></span></button></li>`)}</ul>` : html`<div class="card muted small">Nothing waiting.</div>`}` : ""}
      ${recent.length ? html`<div class="section-h">Recent bulk sends</div><ul class="list">${recent.map(bulkRow)}</ul>` : ""}
    </div>`;
  },
  events: {
    "click [data-bulk]": (e, el, ctx) => bulkSheet(el.getAttribute("data-bulk"), ctx),
    "click [data-pending]": (e, el, ctx) => pendingSheet(el.getAttribute("data-pending"), ctx),
  },
};
