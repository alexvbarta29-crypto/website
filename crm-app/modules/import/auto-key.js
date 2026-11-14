// Automatic daily import (design §10.9 "daily delta imports", §4.9;
// owners): the long-lived key a scheduled job outside the CRM uses to bring
// Rotor's newest export in every day. It can only create an import run and
// upload and start that run: it reads nothing and opens no other screen or
// API. Shown once; making a new one stops the old one; Revoke stops it at
// once. Each automatic import tells the owners when it's done, and every
// use is on the Audit screen. The scheduled job exports Rotor read-only:
// nothing here changes Rotor.

import { html, icon, toast, sheet, confirmSheet, attrs } from "../../core/ui.js";
import { ago, dateTime } from "../../core/format.js";
import { ensureStyles, runPill, exportLabel, n } from "./kit.js";

// The command the scheduled job runs (the key from a file outside the repository, never on the command line).
export const AUTO_COMMAND = "node build/crm_import_upload.mjs ~/barta-private/import-pack --site https://www.bartawindowwashing.com --key-file ~/barta-private/auto-import-key.txt";

function keySheet(key) {
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (e) { toast("Press and hold to copy it."); }
  };
  sheet({
    title: "Automatic import key",
    body: html`<p class="muted">Shown once: copy it now and put it in the scheduled job's key file (outside the website's folder). It can only start an import of a packed Rotor export.</p>
      <div class="copy-box"><input type="text" readonly ${attrs({ value: key, "aria-label": "Automatic import key" })}><button type="button" class="btn dark" data-copy-key>${icon("copy")}Copy</button></div>
      <p class="small muted im-gap">The job runs this after its read-only export and the pack:</p>
      <pre class="im-cmd">${AUTO_COMMAND}</pre>`,
    events: { "click [data-copy-key]": () => copy(key, "Key") },
  });
}

export default {
  title: "Automatic daily import",
  async load(params, ctx) {
    ensureStyles();
    return (await ctx.api("/import/auto-key", { cache: false })).data;
  },
  render(s) {
    const k = s.key;
    return html`<div class="stack">
      <section class="card">
        <h2>Bring Rotor in every day</h2>
        <p>A scheduled job on the computer that holds the exports reads Rotor (never changes it), packs the export and sends it here with this key every day. Each import adds what's new and applies Rotor's changes; nothing is deleted, and anything changed on both sides waits for you on the Conflicts screen.</p>
        ${k ? html`<dl class="kv im-gap"><dt>Key</dt><dd>…${k.last4} · ${k.name}</dd><dt>Made</dt><dd>${dateTime(k.created_at)}</dd><dt>Last used</dt><dd>${k.last_used_at ? ago(k.last_used_at) : "Not yet"}</dd><dt>Imports</dt><dd>${n(k.uses)}</dd></dl>
          <div class="btn-row"><button type="button" class="btn" data-make>New key</button><button type="button" class="btn danger" ${attrs({ "data-revoke": k.id })}>Revoke</button></div>`
          : html`<p class="warn-box im-gap">No key yet: the daily import is off.</p><div class="btn-row"><button type="button" class="btn primary" data-make>${icon("key")}Make the key</button></div>`}
        <p class="small muted im-gap">At most ${n(s.per_day)} imports a day, never an export older than the newest one here, never while the CRM is paused. You get a note when each one is done.</p>
      </section>
      <div class="section-h">Automatic imports</div>
      ${s.runs.length ? html`<ul class="list">${s.runs.map((r) => html`<li><a class="row" ${attrs({ href: "#/import/" + r.id })}>
        <span class="who"><span class="nm">${exportLabel(r.as_of)}</span><span class="sub">${r.summary ? `${n(r.summary.created)} added · ${n(r.summary.updated)} updated` : ago(r.created_at)}</span></span>
        <span class="end">${runPill({ status: r.status, conflicts: { open: r.summary ? r.summary.conflicts : 0 } })}</span></a></li>`)}</ul>`
        : html`<div class="card empty"><p>None yet.</p></div>`}
      ${s.earlier.length ? html`<div class="section-h">Earlier keys</div><ul class="co-list">${s.earlier.map((e) => html`<li class="co-item"><span class="who"><span class="nm">…${e.last4} · ${e.name}</span><span class="sub">Revoked ${dateTime(e.revoked_at)} · ${n(e.uses)} imports</span></span></li>`)}</ul>` : ""}
    </div>`;
  },
  events: {
    "click [data-make]": async (e, el, ctx) => {
      if (ctx.state.key && !(await confirmSheet("The key the scheduled job has now stops working at once.", { title: "Make a new key?", yes: "Make it" }))) return;
      el.disabled = true;
      try { const r = await ctx.api("/import/auto-key", { method: "POST", body: {} }); keySheet(r.data.key); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-revoke]": async (e, el, ctx) => {
      if (!(await confirmSheet("The scheduled job can't import any more until you make a new key.", { title: "Revoke the key?", yes: "Revoke", danger: true }))) return;
      try { await ctx.api(`/import/auto-key/${encodeURIComponent(el.dataset.revoke)}`, { method: "DELETE" }); toast("Revoked"); ctx.refresh(); }
      catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
