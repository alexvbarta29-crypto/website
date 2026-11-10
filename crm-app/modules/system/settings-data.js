// Settings → Data (design §9.2, §3.12): the workers' health and alerts,
// the nightly backups and the last off-site copy, a CSV export of one kind
// of record (owners), rebuilding the lists, and pausing everything (owners,
// typed PAUSE / RESUME: no text, email, charge or automation while paused).

import { html, toast, confirmSheet, sheet, attrs } from "../../core/ui.js";
import { ago, dateShort, plural } from "../../core/format.js";

const LANE = { ok: ["green", "Running"], stuck: ["red", "Stuck"], never: ["amber", "Not started yet"] };
const EXPORTS = [["user", "Team"], ["contact", "Contacts"], ["quote", "Quotes"], ["job", "Jobs"], ["visit", "Visits"], ["invoice", "Invoices"], ["payment", "Payments"], ["template", "Templates"]];

async function typed(word, title, text) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title,
      body: html`<form class="form" data-typed><p class="muted">${text}</p><label class="field"><span>Type ${word} to confirm</span><input ${attrs({ name: "word", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" })}></label><button type="submit" class="btn danger block">${title}</button></form>`,
      onClose: () => { if (!answered) resolve(null); },
      events: { "submit [data-typed]": (e, f) => { e.preventDefault(); answered = true; resolve(String(f.querySelector("[name=word]").value || "").trim().toUpperCase()); s.close(); } },
    });
  });
}

async function waitRun(ctx, id, onTick) {
  for (let i = 0; i < 90; i++) {
    const r = (await ctx.api(`/runs/${encodeURIComponent(id)}`, { cache: false })).data;
    if (onTick) onTick(r);
    if (["done", "failed", "cancelled"].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

export default {
  title: "Data",
  async load(params, ctx) {
    const [health, backups, mode] = await Promise.all([
      ctx.api("/admin/health", { cache: false }).then((r) => r.data),
      ctx.can("export:all") ? ctx.api("/admin/backups", { cache: false }).then((r) => r.data).catch(() => []) : [],
      Promise.resolve(null),
    ]);
    return { health, backups, mode };
  },
  render(s, ctx) {
    const h = s.health || {};
    const owner = ctx.can("settings:owner");
    const lane = (k) => { const [cls, label] = LANE[(h.status || {})[k]] || LANE.never; const l = (h.lanes || {})[k] || {}; return html`<li><div class="row"><span class="who"><span class="nm">${k === "fast" ? "Fast lane" : "Bulk lane"}</span><span class="sub">${l.last_pass_at ? "Last pass " + ago(l.last_pass_at) : "No pass yet"}</span></span><span class="end"><span class="pill ${cls}">${label}</span></span></div></li>`; };
    const last = (s.backups || []).find((b) => b.ok);
    return html`<div class="stack">
      ${(h.alerts || []).length ? html`<div class="card alert"><h2>Needs a look</h2>${h.alerts.map((a) => html`<p>${a.text}</p>`)}</div>` : ""}
      <div class="section-h">Workers</div>
      <ul class="list">${lane("fast")}${lane("bulk")}<li><div class="row"><span class="who"><span class="nm">Scheduled work</span><span class="sub">${plural((h.queue && h.queue.depth) || 0, "step")} waiting${h.queue && h.queue.next_due_at ? " · next " + ago(h.queue.next_due_at) : ""}</span></span></div></li></ul>
      <div class="section-h">Backups</div>
      <div class="card"><dl class="kv">
        <dt>Last nightly copy</dt><dd>${last ? dateShort(last.date) : h.backup && h.backup.date ? dateShort(h.backup.date) : "None yet"}</dd>
        <dt>Off-site copy</dt><dd>${h.offsite_at ? ago(h.offsite_at) : "None yet"}</dd>
        <dt>Nightly check</dt><dd>${h.index_verify ? (h.index_verify.missing + h.index_verify.extra + h.index_verify.stale ? "Repaired lists" : "All lists match") + " · " + ago(h.index_verify.at) : "Not run yet"}</dd>
      </dl>
      ${s.backups && s.backups.length ? html`<p class="small">${plural(s.backups.length, "snapshot")} kept (35 days, plus the 1st of each month for a year).</p>` : ""}</div>
      ${ctx.can("export:all") ? html`<div class="section-h">Download</div>
        <div class="card"><p class="small">A spreadsheet (CSV) of one kind of record, from last night's backup.</p>
          <div class="stat-row">${EXPORTS.map(([type, label]) => html`<button type="button" class="chip" data-export="${type}">${label}</button>`)}</div>
          <p class="small" data-export-status hidden></p></div>` : ""}
      ${owner ? html`<div class="section-h">Owner switches</div>
        <div class="card"><p class="small">Pausing stops every text, email, charge and automation until you resume. A restore pauses on its own.</p>
          <div class="btn-row"><button type="button" class="btn danger" data-pause>Pause everything</button><button type="button" class="btn" data-resume>Resume</button></div>
          <div class="btn-row"><button type="button" class="btn" data-reindex>Rebuild the lists</button></div></div>` : ""}
    </div>`;
  },
  events: {
    "click [data-export]": async (e, el, ctx) => {
      const status = el.closest(".card").querySelector("[data-export-status]");
      status.hidden = false;
      status.textContent = "Preparing…";
      try {
        const r = await ctx.api(`/admin/export.csv?type=${encodeURIComponent(el.getAttribute("data-export"))}`, { method: "POST", body: {} });
        const done = await waitRun(ctx, r.data.run_id || (r.data.run && r.data.run.id), (x) => { status.textContent = x.status === "running" ? "Preparing…" : status.textContent; });
        if (!done || done.status !== "done") { status.textContent = "That didn't finish. Try again in a minute."; return; }
        status.textContent = "";
        const a = document.createElement("a");
        a.href = `/api/crm/admin/export.csv/${encodeURIComponent(done.id)}`;
        a.download = "";
        a.textContent = "Download the CSV";
        a.className = "btn dark";
        status.appendChild(a);
      } catch (err) { status.textContent = err.message; }
    },
    "click [data-pause]": async (e, el, ctx) => {
      const w = await typed("PAUSE", "Pause everything", "No text, email, charge or automation goes out until you resume.");
      if (!w) return;
      try { await ctx.api("/admin/pause", { method: "POST", body: { confirm: w } }); toast("Paused"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-resume]": async (e, el, ctx) => {
      const w = await typed("RESUME", "Resume", "Texts, emails and automations start again.");
      if (!w) return;
      try { await ctx.api("/admin/resume", { method: "POST", body: { confirm: w } }); toast("Resumed"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-reindex]": async (e, el, ctx) => {
      if (!(await confirmSheet("Every list is rebuilt from the records in the background. It's safe at any time.", { title: "Rebuild the lists?", yes: "Rebuild" }))) return;
      try { await ctx.api("/admin/reindex", { method: "POST", body: {} }); toast("Started. It runs in the background."); } catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
