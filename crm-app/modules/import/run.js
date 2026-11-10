// One import (design §10.1, §10.8, §10.10; owners): the upload (chunks and
// media received, a fresh key, uploading a small pack from this phone),
// the team map (each Rotor member and the CRM user it becomes: by name,
// or the owner's choice), Start, the phases as they run (refreshed every
// few seconds while it runs), the conflicts to settle, and once done the
// report (counts, what waits for a module not built yet, Rotor's money,
// data quality) with the report and id map downloads.

import { html, icon, toast, confirmSheet, attrs } from "../../core/ui.js";
import { money, dateTime } from "../../core/format.js";
import { ensureStyles, runPill, phasePill, exportLabel, whenLabel, warnLabel, n } from "./kit.js";
import { keySheet } from "./list.js";

const ROLE = { owner: "Owner", admin: "Office", member: "Technician" };
const LIVE = new Set(["uploading", "queued", "running"]);
let timer = null;
let watching = null;
const stopWatch = () => { if (timer) clearInterval(timer); timer = null; watching = null; };

async function loadAll(id, ctx) {
  const d = (await ctx.api(`/import/runs/${encodeURIComponent(id)}`, { cache: false })).data;
  let report = null;
  if (d.run.status === "done") report = (await ctx.api(`/import/runs/${encodeURIComponent(id)}/report`, { cache: false }).catch(() => null) || {}).data || null;
  return { ...d, report };
}

const stopped = (s) => s.run.status === "running" && s.lane && (s.lane.status === "failed" || s.lane.status === "cancelled");

function uploadCard(s) {
  const u = s.upload;
  const r = s.run;
  const complete = u.expected > 0 && u.missing_count === 0;
  return html`<section class="card">
    <h2>Upload</h2>
    <dl class="kv">
      <dt>Chunks</dt><dd>${u.expected ? `${n(u.chunks)} of ${n(u.expected)} received` : r.manifest ? "0 received" : "Waiting for the pack"}</dd>
      <dt>Media</dt><dd>${n(u.media)}${u.media_expected ? ` of ${n(u.media_expected)}` : ""} files</dd>
      ${r.status === "uploading" && r.upload ? html`<dt>Upload key</dt><dd>…${r.upload.last4} · ${r.upload.expired ? "ran out" : "good until " + dateTime(r.upload.expires_at)}</dd>` : ""}
    </dl>
    ${u.missing_count && u.chunks ? html`<p class="small muted">Still missing: ${u.missing.join(", ")}${u.missing_count > u.missing.length ? "…" : ""}</p>` : ""}
    ${r.status === "uploading" ? html`
      <div class="btn-row">
        <button type="button" class="btn primary" data-start ${attrs({ disabled: !complete })}>Start the import</button>
        <button type="button" class="btn" data-rekey>New upload key</button>
      </div>
      <details class="im-phone"><summary>Upload a small pack from this phone</summary>
        <p class="small muted">Pick manifest.json and the .sealed.json files from the pack folder (the media files only go up with the upload script).</p>
        <label class="btn im-file">${icon("plus")}Choose files<input type="file" multiple accept=".json,application/json" data-files></label>
        <p class="small" data-up-status hidden></p>
      </details>` : ""}
  </section>`;
}

function teamCard(s) {
  const t = s.team;
  if (!t) return "";
  const editable = s.run.status === "uploading" && !t.done;
  return html`<section class="card">
    <h2>Team</h2>
    <p class="small muted">${t.done ? "Rotor's members and who they are in the CRM." : "Each Rotor member becomes the CRM user with the same name. Change one if the names differ; a member left as New becomes an invited user."}</p>
    <ul class="im-team">${t.members.map((m) => html`<li>
      <span class="who"><span class="nm">${m.name}</span><span class="sub">${ROLE[m.role] || m.role} in Rotor</span></span>
      ${editable ? html`<select class="im-sel" ${attrs({ "data-member": m.rid, "aria-label": "CRM user for " + m.name })}>
          <option value="" ${attrs({ selected: !m.match })}>New user (invited)</option>
          ${t.users.filter((u) => u.status !== "disabled").map((u) => html`<option ${attrs({ value: u.id, selected: !!(m.match && m.match.id === u.id) })}>${u.name}</option>`)}
        </select>`
        : html`<span class="end">${m.match ? html`<span class="pill green">${m.match.name || "Matched"}</span>` : html`<span class="pill amber">New user</span>`}</span>`}
    </li>`)}</ul>
  </section>`;
}

function phasesCard(s) {
  const run = s.phases.filter((p) => p.status !== "waiting");
  const waiting = s.phases.filter((p) => p.status === "waiting");
  if (!s.phases.length) return "";
  return html`<section class="card">
    <h2>Steps</h2>
    <ul class="im-phases">${run.map((p) => html`<li>
      <div class="im-ph-top"><span class="nm">${p.label}</span>${phasePill(p)}</div>
      ${p.read || p.status === "running" || p.status === "done" ? html`<div class="sub">${n(p.read)} read · ${n(p.created)} added · ${n(p.updated)} updated · ${n(p.unchanged)} unchanged${p.linked ? ` · ${n(p.linked)} linked` : ""}${p.conflicted ? ` · ${n(p.conflicted)} to settle` : ""}${p.skipped ? ` · ${n(p.skipped)} skipped` : ""}</div>` : ""}
    </li>`)}</ul>
    ${waiting.length ? html`<p class="small muted im-gap">Waiting for parts of the CRM that aren't built yet (a later import brings them in): ${[...new Set(waiting.map((p) => p.waiting_label).filter(Boolean))].join(", ")}.</p>` : ""}
  </section>`;
}

function reportCard(s) {
  const rep = s.report;
  if (!rep) return "";
  const sum = rep.summary || {};
  const tiles = [["Added", sum.created], ["Updated", sum.updated], ["Unchanged", sum.unchanged], ["Linked", sum.linked], ["To settle", s.run.conflicts ? s.run.conflicts.open : sum.conflicts_open], ["Skipped", sum.skipped]];
  const warns = Object.entries((rep.quality && rep.quality.warnings) || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const m = (rep.money && rep.money.rotor) || null;
  // what waits, per part of the CRM: each entity's rows counted once
  const groups = new Map();
  for (const w of rep.waiting || []) {
    if (!w.rows) continue;
    const k = w.module_label || w.module;
    const g = groups.get(k) || { label: k, entities: new Map(), steps: [] };
    g.entities.set(w.entity, w.rows);
    g.steps.push(String(w.label || "").toLowerCase());
    groups.set(k, g);
  }
  const waits = [...groups.values()].map((g) => ({ label: g.label, rows: [...g.entities.values()].reduce((a, b) => a + b, 0), steps: g.steps }));
  const base = `/api/crm/import/runs/${encodeURIComponent(s.run.id)}`;
  return html`<section class="card">
    <h2>Report</h2>
    <div class="im-tiles">${tiles.map(([label, v]) => html`<div class="im-tile"><b>${n(v)}</b><span>${label}</span></div>`)}</div>
    ${(s.run.conflicts && s.run.conflicts.open) ? html`<p class="warn-box im-gap">${n(s.run.conflicts.open)} ${s.run.conflicts.open === 1 ? "field" : "fields"} changed both here and in Rotor. <a ${attrs({ href: `#/import/${s.run.id}/conflicts` })}>Settle them</a></p>` : html`<p class="ok-box im-gap">Nothing to settle.</p>`}
    ${waits.length ? html`<div class="section-h">Waiting for a later part of the CRM</div>
      <dl class="kv">${waits.map((w) => html`<dt>${w.label}</dt><dd>${n(w.rows)} ${w.rows === 1 ? "row" : "rows"}<span class="im-steps">${w.steps.join(", ")}</span></dd>`)}</dl>` : ""}
    ${m ? html`<div class="section-h">Money in Rotor (to compare with Rotor's reports)</div>
      <dl class="kv"><dt>Invoices</dt><dd>${n(m.invoices.count)} · ${money(m.invoices.total_cents)}</dd>
        <dt>Payments</dt><dd>${n(m.payments.count)} · ${money(m.payments.net_cents)}</dd>
        <dt>Refunds</dt><dd>${money(m.payments.refunds_cents)}</dd><dt>Tips</dt><dd>${money(m.payments.tips_cents)}</dd></dl>
      <p class="small muted">The CRM's side of this comparison arrives with Money.</p>` : ""}
    ${warns.length ? html`<div class="section-h">Data quality</div><dl class="kv">${warns.map(([k, v]) => html`<dt>${warnLabel(k)}</dt><dd>${n(v)}</dd>`)}</dl>` : ""}
    <div class="btn-row im-gap"><a class="btn" ${attrs({ href: base + "/report.csv", download: "" })}>${icon("doc")}Report (CSV)</a><a class="btn" ${attrs({ href: base + "/idmap.csv", download: "" })}>${icon("data")}Id map (CSV)</a></div>
    <p class="small muted">The id map lists every Rotor id and the CRM record it became. Downloading it is recorded.</p>
  </section>`;
}

export default {
  title: (s) => (s && s.run ? exportLabel(s.run.as_of) : "Import"),
  async load(params, ctx) {
    ensureStyles();
    return loadAll(params.id, ctx);
  },
  render(s) {
    const r = s.run;
    return html`<div class="stack">
      <section class="card">
        <div class="im-head"><h2>${exportLabel(r.as_of)}</h2>${runPill(r, s.lane)}</div>
        <p class="small muted">${r.note ? r.note + " · " : ""}Made ${whenLabel(r.created_at)}${r.started_at ? " · started " + whenLabel(r.started_at) : ""}${r.finished_at ? " · finished " + whenLabel(r.finished_at) : ""}</p>
        ${stopped(s) ? html`<p class="warn-box">It stopped: storage kept failing. Resume goes on from where it stopped; nothing done is done again.</p>
          <div class="btn-row"><button type="button" class="btn primary" data-resume>Resume</button></div>` : ""}
        ${LIVE.has(r.status) && !stopped(s) && r.status !== "uploading" ? html`<p class="small">${s.finish && s.finish !== "indexes" ? "Finishing: lists, the id map, the report…" : "Importing in the background. You can leave this screen."}</p>` : ""}
        ${LIVE.has(r.status) ? html`<div class="btn-row"><button type="button" class="btn" data-cancel>Cancel this import</button></div>` : ""}
      </section>
      ${r.status === "uploading" ? html`${teamCard(s)}${uploadCard(s)}` : html`${r.status === "done" ? reportCard(s) : ""}${phasesCard(s)}${teamCard(s)}`}
      ${r.status === "done" ? "" : html`<p class="small muted im-foot">Conflicts, the report and the id map are ready when the import is done.</p>`}
    </div>`;
  },
  mount(v, s, ctx) {
    if (!LIVE.has(s.run.status) || stopped(s)) { stopWatch(); return; }
    if (watching === s.run.id && timer) return;
    stopWatch();
    watching = s.run.id;
    timer = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const next = await loadAll(s.run.id, ctx);
        if (watching !== s.run.id) return;
        ctx.state = next;
        ctx.rerender();
      } catch (e) { /* the next tick tries again */ }
    }, 4000);
  },
  unmount() { stopWatch(); },
  events: {
    "click [data-start]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/import/runs/${encodeURIComponent(ctx.state.run.id)}/start`, { method: "POST", body: {} }); toast("Started"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-resume]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/import/runs/${encodeURIComponent(ctx.state.run.id)}/resume`, { method: "POST", body: {} }); toast("Going on"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-cancel]": async (e, el, ctx) => {
      if (!(await confirmSheet("What was imported so far stays. The upload key stops working.", { title: "Cancel this import?", yes: "Cancel it", no: "Keep it", danger: true }))) return;
      try { await ctx.api(`/import/runs/${encodeURIComponent(ctx.state.run.id)}/cancel`, { method: "POST", body: {} }); toast("Cancelled"); ctx.refresh(); }
      catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-rekey]": async (e, el, ctx) => {
      if (!(await confirmSheet("The old key stops working.", { title: "Make a new upload key?", yes: "Make it" }))) return;
      try { const r = await ctx.api(`/import/runs/${encodeURIComponent(ctx.state.run.id)}/key`, { method: "POST", body: {} }); keySheet(ctx, { key: r.data.upload_key, run: r.data.run }); ctx.refresh(); }
      catch (err) { toast(err.message, { bad: true }); }
    },
    "change [data-member]": async (e, el, ctx) => {
      const uid = el.value || null;
      try {
        await ctx.api(`/import/runs/${encodeURIComponent(ctx.state.run.id)}/user-map`, { method: "POST", body: { map: { [el.dataset.member]: uid } } });
        toast(uid ? "Matched" : "Will be a new user");
      } catch (err) { toast(err.message, { bad: true }); ctx.refresh(); }
    },
    "change [data-files]": async (e, el, ctx) => {
      const status = el.closest("details").querySelector("[data-up-status]");
      status.hidden = false;
      const files = [...el.files].sort((a, b) => (a.name === "manifest.json" ? -1 : b.name === "manifest.json" ? 1 : a.name < b.name ? -1 : 1));
      const id = encodeURIComponent(ctx.state.run.id);
      let sent = 0;
      try {
        for (const f of files) {
          const body = JSON.parse(await f.text());
          if (f.name === "manifest.json") await ctx.api(`/import/runs/${id}/manifest`, { method: "PUT", body, timeout: 30000 });
          else {
            const m = /^([a-z][a-z0-9_]*-\d{4})\.sealed\.json$/.exec(f.name);
            if (!m) continue;
            status.textContent = `Sending ${m[1]}…`;
            await ctx.api(`/import/runs/${id}/chunks/${m[1]}`, { method: "PUT", body, timeout: 90000 });
          }
          sent += 1;
        }
        status.textContent = `${sent} ${sent === 1 ? "file" : "files"} sent.`;
      } catch (err) { status.textContent = err.message || "That file didn't go up. Try again."; }
      ctx.refresh();
    },
  },
};
