// Import from Rotor (design §10, §9.2; owners): every import so far, newest
// first, and "Start an import". Starting one makes the run and shows its
// one-run upload key once, with the command the integrator runs on the
// computer that holds the export (the main path; the script asks for the
// key, so it never lands in a shell history); a small run can also be
// uploaded from this phone on the run's screen. The owner starts the run
// on its screen once the upload is in and the team map looks right.
// "The rest of this export": what the latest finished import left waiting
// for parts of the CRM that weren't live, what of it can come in now, and
// "Bring in the rest now" (no upload: the rows are still here).

import { html, icon, sheet, toast, attrs } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { ensureStyles, runPill, exportLabel, whenLabel, n, restCard, bringInRest } from "./kit.js";

// The command shows no key: the script asks for it at a prompt that doesn't echo (never in the shell's history).
export const UPLOAD_COMMAND = "node build/crm_import_upload.mjs ~/barta-private/import-pack --site https://www.bartawindowwashing.com";

// The key, once: copy it, or copy the whole command.
export function keySheet(ctx, { key, run }) {
  const cmd = UPLOAD_COMMAND;
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
    catch (e) { toast("Press and hold to copy it."); }
  };
  const s = sheet({
    title: "Upload key",
    body: html`<p class="muted">This key uploads the export to this import only, for 24 hours. It is shown once: copy it now.</p>
      <div class="copy-box"><input type="text" readonly ${attrs({ value: key, "aria-label": "Upload key", "data-key": "" })}><button type="button" class="btn dark" data-copy-key>${icon("copy")}Copy</button></div>
      <p class="small muted im-gap">On the computer with the export, after packing it, run this and paste the key when it asks (it isn't shown or saved):</p>
      <pre class="im-cmd">${cmd}</pre>
      <p class="small muted">When the upload is done, check the team on this import's screen and tap Start the import.</p>
      <div class="btn-row"><button type="button" class="btn" data-copy-cmd>${icon("copy")}Copy the command</button><button type="button" class="btn primary" data-open>Open the import</button></div>`,
    events: {
      "click [data-copy-key]": () => copy(key, "Key"),
      "click [data-copy-cmd]": () => copy(cmd, "Command"),
      "click [data-open]": () => { s.close(); ctx.go(`/import/${run.id}`); },
    },
  });
  return s;
}

export default {
  title: "Import from Rotor",
  async load(params, ctx) {
    ensureStyles();
    const [r, rest] = await Promise.all([
      ctx.api("/import/runs", { cache: false }),
      ctx.api("/import/rest", { cache: false }).then((x) => x.data).catch(() => null),
    ]);
    return { runs: r.data || [], rest };
  },
  render(s) {
    const active = s.runs.find((r) => r.status === "queued" || r.status === "running");
    return html`<div class="stack">
      <section class="card">
        <h2>Bring Rotor's data in</h2>
        <p>Rotor stays in charge until the switch-over. Each import brings the newest Rotor export into the CRM: new records are added, Rotor's changes are applied, nothing is deleted, and a field someone changed here and Rotor changed too is listed for you to settle.</p>
        <div class="btn-row">${active
          ? html`<a class="btn" ${attrs({ href: "#/import/" + active.id })}>See the import that's running</a>`
          : html`<button type="button" class="btn primary" data-start>${icon("plus")}Start an import</button>`}</div>
      </section>
      ${restCard(s.rest)}
      <div class="section-h">Imports</div>
      ${s.runs.length ? html`<ul class="list">${s.runs.map((r) => html`<li><a class="row" ${attrs({ href: "#/import/" + r.id })}>
        <span class="who"><span class="nm">${exportLabel(r.as_of)}</span>
          <span class="sub">${r.continues ? "More of this export · " : ""}${r.summary ? `${n(r.summary.created)} added · ${n(r.summary.updated)} updated` : "Started " + whenLabel(r.created_at)}</span></span>
        <span class="end">${runPill({ status: r.status, conflicts: { open: r.summary ? r.summary.conflicts : 0 } })}<span class="chev">${icon("back")}</span></span>
      </a></li>`)}</ul>` : html`<div class="card empty"><div class="art">${icon("data")}</div><h2>No imports yet</h2><p>Start one, then upload the packed Rotor export with its key.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-continue]": (e, el, ctx) => bringInRest(el, ctx),
    "click [data-start]": (e, el, ctx) => {
      const s = sheet({
        title: "Start an import",
        body: html`<form class="form" id="start-f" novalidate><div class="err" data-form-err hidden></div>
          <p class="muted">You get an upload key for this import. The export is packed and uploaded from the computer that holds it; when the upload is done, you check the team and start the import here.</p>
          ${field({ label: "Note (optional)", name: "note", hint: "Like \"weekly\" or \"final before the switch\".", autocomplete: "off" })}
          <button type="submit" class="btn primary block">Make the upload key</button></form>`,
        events: {
          "submit #start-f": async (ev, form) => {
            ev.preventDefault(); clearErrors(form);
            const btn = form.querySelector("[type=submit]"); busy(btn, true, "Making…");
            try {
              const r = await ctx.api("/import/runs", { method: "POST", body: { note: readForm(form).note || null } });
              s.close();
              keySheet(ctx, { key: r.data.upload_key, run: r.data.run });
              ctx.refresh();
            } catch (err) { busy(btn, false); showError(form, err); }
          },
        },
      });
    },
  },
};
