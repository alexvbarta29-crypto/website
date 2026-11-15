// Workflows (Marketing's first tab; the Rotor guide's K1 to K3 and Flyra's
// K16): every workflow in one list, your own and the built-in ones, each a
// row with its on/off switch, in folders by what it is about (Jobs,
// Estimates, Payments, Subscriptions, Reviews, Customers, Misc, and
// folders of your own). The tiles All · On · Off filter it, the folder
// chip picks one folder; a long press on one of yours: Edit, Run history,
// Duplicate, Move to folder, Delete. Settings → Messages → Automatic
// messages opens this same list.
// Before (design §9.2, §5.7.4): first your own (the builder,
// modules/automations: each one on or off, its sentence, how many runs and
// the last; New automation from scratch or from a starter; the limits every
// one shares), then the built-in catalog. Each built-in: on or off, when it
// runs, what it sends, and the last 7 days (sent, dry run, skipped, "would
// have" while Rotor is in charge). Tap one for its settings (channels,
// delay, time of day, templates) and today's log. Automations of modules
// that haven't shipped show "Arrives with ...". Before the switch-over
// everything that would reach a customer goes to the Outbox instead.
// automations:configure (owners and the office).

import { html, attrs, icon, sheet, toast, confirmSheet, tileRow, tileToggle, sectionLabel, statusPill, actionSheet, emptyCard } from "../../core/ui.js";
import { readForm, busy, checkbox, field, clearErrors, showError } from "../../core/forms.js";
import { time as fmtTime, dateTime } from "../../core/format.js";
import { reasonLabel } from "./kit.js";

const last7 = (l) => {
  if (!l) return "Nothing in the last 7 days";
  const parts = [];
  if (l.sent) parts.push(`${l.sent} sent`);
  if (l.dry_run) parts.push(`${l.dry_run} in the outbox`);
  if (l.would) parts.push(`${l.would} would have`);
  if (l.skipped) parts.push(`${l.skipped} skipped`);
  if (l.failed) parts.push(`${l.failed} failed`);
  return parts.length ? parts.join(" · ") + " (7 days)" : "Nothing in the last 7 days";
};

function editSheet(a, ctx, templates) {
  const st = a.settings || {};
  const tpl = templates.filter((t) => (st.channels || ["sms"]).includes(t.channel) || (st.template_keys || []).includes(t.key));
  const s = sheet({
    title: a.label,
    body: html`<form class="form" data-edit>
      <div class="err" data-form-err hidden></div>
      <p class="small muted">${a.when || ""}${a.action ? " · " + plainAction(a.action, templates) : ""}</p>
      <div class="section-h">Send by</div>
      ${checkbox({ label: "Text", name: "ch_sms", checked: (st.channels || []).includes("sms") })}
      ${checkbox({ label: "Email", name: "ch_email", checked: (st.channels || []).includes("email") })}
      <div class="grid2">
        ${field({ label: "Wait (minutes)", name: "delay", value: String(st.delay ?? 0), inputmode: "numeric" })}
        <label class="field" data-field="at_local"><span>At (time of day)</span><input ${attrs({ type: "time", name: "at_local", value: st.at_local || "" })}><small class="why" hidden></small></label>
      </div>
      <div class="section-h">Templates</div>
      ${tpl.length ? tpl.map((t) => checkbox({ label: `${t.name} (${t.channel === "sms" ? "text" : "email"})`, name: `tpl_${t.key}`, checked: (st.template_keys || []).includes(t.key) })) : html`<p class="small muted">No templates for it yet.</p>`}
      <button type="submit" class="btn primary block">Save</button>
      <button type="button" class="btn block" data-log>Today's log</button>
    </form>`,
    events: {
      "submit [data-edit]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true);
        const channels = [v.ch_sms ? "sms" : null, v.ch_email ? "email" : null].filter(Boolean);
        const template_keys = tpl.filter((t) => v[`tpl_${t.key}`]).map((t) => t.key);
        try {
          await ctx.api(`/automations/${encodeURIComponent(a.key)}`, { method: "PATCH", body: { channels, template_keys, delay: Number(v.delay || 0), at_local: v.at_local || null } });
          toast("Saved");
          s.close();
          ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
      "click [data-log]": async () => { s.close(); logSheet(a, ctx); },
    },
  });
}

async function logSheet(a, ctx) {
  let rows = [];
  try { rows = (await ctx.api(`/automations/log?key=${encodeURIComponent(a.key)}`, { cache: false })).data || []; } catch (e) { rows = []; }
  sheet({
    title: `${a.label}: today`,
    body: rows.length
      ? html`<ul class="list">${rows.map((r) => html`<li><div class="row"><span class="who"><span class="nm">${r.result === "dry_run" ? "In the outbox (dry run)" : r.result === "sent" ? "Sent" : r.result.startsWith("would-") ? "Would have: " + r.result.slice(6).replace(/_/g, " ") : r.result.startsWith("skipped") ? "Skipped: " + reasonLabel(r.result) : r.result}</span><span class="sub mono">${r.subject}</span></span><span class="end small muted">${fmtTime(r.at)}</span></div></li>`)}</ul>`
      : html`<p class="muted">Nothing today.</p>`,
  });
}

// New automation: from scratch, or one of the starters (created off).
function newSheet(s, ctx) {
  const make = async (body) => {
    try {
      const r = await ctx.api("/automations/flows", { method: "POST", body });
      sh.close();
      toast("Made (off until you turn it on)");
      ctx.go(`/automations/flow/${r.data.flow.id}`);
    } catch (err) { toast(err.message, { bad: true }); }
  };
  const sh = sheet({
    title: "New automation",
    body: html`<div class="stack">
      <button type="button" class="btn primary block" data-scratch>${icon("plus")}Start from scratch</button>
      <div class="section-h">Or start from</div>
      <ul class="au-recipes">${(s.flows.recipes || []).map((x) => html`<li><button type="button" ${attrs({ "data-recipe": x.key })}><b>${x.label}</b><span>${x.blurb}</span></button></li>`)}</ul>
    </div>`,
    events: {
      "click [data-scratch]": () => make({ name: "New automation", trigger: { type: "quote.sent" }, steps: [{ type: "task", title: "Follow up", assign: "owner", wait: { n: 1, unit: "days" } }] }),
      "click [data-recipe]": (e, el) => make({ recipe: el.getAttribute("data-recipe") }),
    },
  });
}

// The limits every custom automation shares (Settings document "flows").
async function limitsSheet(s, ctx) {
  let etag = "new";
  let cur = s.flows.settings || {};
  try { const g = await ctx.api("/settings/flows", { cache: false }); etag = g.etag || (g.data && g.data.etag) || "new"; cur = { ...cur, ...((g.data && g.data.data) || {}) }; } catch (e) { /* the defaults */ }
  const sh = sheet({
    title: "Limits for your automations",
    body: html`<form class="form" data-limits>
      <div class="err" data-form-err hidden></div>
      ${field({ label: "Automated texts to one customer a day (every automation together)", name: "max_texts_per_day", value: String(cur.max_texts_per_day ?? 2), inputmode: "numeric", maxlength: 2 })}
      ${field({ label: "Starts of one automation a day before it switches itself off", name: "max_runs_per_day", value: String(cur.max_runs_per_day ?? 200), inputmode: "numeric", maxlength: 4 })}
      <button type="submit" class="btn primary block">Save</button>
    </form>`,
    events: {
      "submit [data-limits]": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("button[type=submit]"); busy(btn, true);
        try {
          await ctx.api("/settings/flows", { method: "PUT", ifMatch: etag, body: { max_texts_per_day: Number(v.max_texts_per_day), max_runs_per_day: Number(v.max_runs_per_day) } });
          toast("Saved"); sh.close(); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

// ------------------------------------------------------------ the Workflows list (the Rotor guide's K1 to K3, Flyra's K16)

const ON = (x) => (x.kind === "flow" ? !!x.flow.enabled : !!(x.a.settings && x.a.settings.enabled));
export const folderByRules = (key, rules = []) => (rules.find(([p]) => String(key || "").startsWith(p)) || [null, "misc"])[1];
// Every workflow as one row: your own and the built-in ones, each in its folder.
export function rowsOf(s) {
  const rules = (s.flows && s.flows.folder_rules) || [];
  const own = ((s.flows && s.flows.flows) || []).map((f) => ({ kind: "flow", key: f.id, name: f.name, folder: f.folder || "misc", flow: f }));
  const built = s.automations.filter((a) => a.available).map((a) => ({ kind: "built", key: a.key, name: a.label, folder: folderByRules(a.key, rules), a }));
  return [...own, ...built];
}
export const FOLDER_LABELS = { jobs: "Jobs", estimates: "Estimates", payments: "Payments", subscriptions: "Subscriptions", reviews: "Reviews", customers: "Customers", misc: "Misc" };
const folderList = (s) => ((s.flows && s.flows.folders) || Object.entries(FOLDER_LABELS).map(([key, label]) => ({ key, label })));
const labelOf = (s, key) => (folderList(s).find((f) => f.key === key) || { label: key }).label;
export function shownRows(s) {
  return rowsOf(s).filter((x) => (s.tile === "on" ? ON(x) : s.tile === "off" ? !ON(x) : true) && (!s.folder || x.folder === s.folder));
}

const flowRow = (x) => {
  const f = x.flow;
  const draft = !!(f.problems && f.problems.length);
  return html`<li ${attrs({ class: "wf-row", "data-hold": "", "data-flow-more": f.id })}><div class="row">
  <a class="who" style="text-decoration:none;color:inherit" ${attrs({ href: `#/automations/flow/${f.id}` })}>
    <span class="nm two">${f.name}</span><span class="sub two">${f.summary || ""}</span>
    <span class="sub au-st">${statusPill(draft ? "Draft" : f.enabled ? "Active" : "Off", draft ? "amber" : f.enabled ? "green" : "grey")} ${f.runs ? `${f.runs} run${f.runs === 1 ? "" : "s"}` : "No runs yet"}${f.last_run_at ? ` · last ${dateTime(f.last_run_at)}` : ""}${f.auto_paused ? " · switched itself off" : ""}</span>
  </a>
  <span class="end"><button type="button" class="switch" role="switch" ${attrs({ "aria-checked": String(!!f.enabled), "aria-label": `${f.name} on or off`, "data-flow-toggle": f.id })}></button></span>
</div></li>`;
};
// "Text visit_confirm" reads as the template's own name: Text "Visit confirmation".
export const plainAction = (text, templates = []) => String(text || "").replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (k) => {
  const t = templates.find((x) => x.key === k);
  return t ? `"${t.name}"` : k.replace(/_/g, " ");
});
const builtRow = (x, s) => {
  const a = x.a;
  return html`<li class="wf-row"><div class="row">
    <button type="button" class="who linkish" style="text-decoration:none;color:inherit;text-align:left" data-open="${a.key}">
      <span class="nm two">${a.label}</span><span class="sub two">${a.when || a.trigger || ""}${a.action ? " → " + plainAction(a.action, s && s.templates) : ""}</span><span class="sub au-st">${statusPill("Built in", "grey")} ${last7(a.last7)}</span>
    </button>
    <span class="end"><button type="button" class="switch" role="switch" ${attrs({ "aria-checked": String(!!(a.settings && a.settings.enabled)), "aria-label": `${a.label} on or off`, "data-toggle": a.key })}></button></span>
  </div></li>`;
};

function moveSheet(ctx, id) {
  const s = ctx.state;
  const f = s.flows.flows.find((x) => x.id === id);
  if (!f) return;
  const go = async (folder) => {
    try { await ctx.api(`/automations/flows/${encodeURIComponent(id)}/folder`, { method: "POST", body: { folder } }); toast("Moved"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
  };
  actionSheet("Move to folder", [
    folderList(s).filter((x) => x.key !== f.folder).map((x) => ({ label: x.label, icon: "list", data: { "folder-to": x.key }, run: () => go(x.key) })),
    [{ label: "New folder...", icon: "plus", data: { "folder-new": true }, run: () => {
      const sh = sheet({
        title: "New folder",
        body: html`<form class="form" data-nf novalidate>${field({ label: "Name", name: "name", value: "", maxlength: 40 })}<button type="submit" class="btn primary block">Move it there</button></form>`,
        events: { "submit [data-nf]": (e, form) => { e.preventDefault(); const v = form.querySelector("[name=name]").value.trim(); if (!v) { toast("Name the folder.", { bad: true }); return; } sh.close(); go(v); } },
      });
    } }],
  ]);
}

export default {
  title: "Workflows",
  async load(params, ctx) {
    const [r, t, fl] = await Promise.all([ctx.api("/automations", { cache: false }), ctx.api("/templates").catch(() => ({ data: [] })), ctx.api("/automations/flows", { cache: false }).catch(() => null)]);
    if (fl && typeof document !== "undefined") import("../automations/kit.js").then((k) => k.ensureStyles()).catch(() => {});
    // the builder's own sending automations are the engine's, not something to switch here
    return { ...r.data, automations: r.data.automations.filter((a) => !String(a.key).startsWith("flow.")), templates: t.data || [], flows: fl ? fl.data : null, tile: ctx.keep.tile || "all", folder: ctx.keep.folder || null };
  },
  render(s) {
    const all = rowsOf(s);
    const rows = shownRows(s);
    const later = s.automations.filter((a) => !a.available);
    const on = all.filter(ON).length;
    const folders = s.folder ? [s.folder] : folderList(s).map((f) => f.key).filter((k) => rows.some((x) => x.folder === k));
    return html`<div class="stack au-list">
      ${s.paused ? html`<div class="warn-box">Every automation is paused.</div>` : ""}
      ${tileRow([{ key: "all", label: "All", value: all.length }, { key: "on", label: "On", value: on }, { key: "off", label: "Off", value: all.length - on }], { name: "au", on: s.tile, label: "Workflows" })}
      <div class="au-bar">
        <button type="button" class="chip" data-folder-pick ${attrs({ "aria-haspopup": "dialog", "aria-pressed": String(!!s.folder) })}>${s.folder ? labelOf(s, s.folder) : "All folders"} ${icon("chevdown")}</button>
        ${s.flows ? html`<button type="button" class="btn primary" data-new-flow>${icon("plus")}New workflow</button>` : ""}
      </div>
      <div class="note">Until the switch-over, anything an automation would send to a customer goes to the Outbox instead, and changes to records Rotor owns are only reported ("would have").</div>
      ${rows.length ? folders.map((k) => html`${sectionLabel(labelOf(s, k))}<ul class="list">${rows.filter((x) => x.folder === k).map((x) => (x.kind === "flow" ? flowRow(x) : builtRow(x, s)))}</ul>`)
        : emptyCard({ icon: "bolt", title: "Nothing here", text: s.tile === "all" && !s.folder ? "\"When this happens, if that, then do these steps.\" Make your own, or start from one of ours." : "Try another tile or folder." })}
      ${later.length && !s.folder && s.tile !== "on" ? html`${sectionLabel("Arriving with the next parts")}<ul class="list">${later.map((a) => html`<li><div class="row"><span class="ico">${icon("bolt")}</span><span class="who"><span class="nm two">${a.label}</span><span class="sub two">${a.when}</span><span class="sub two">${plainAction(a.action, s.templates)}</span></span><span class="end"><span class="pill">${a.arrives_with}</span></span></div></li>`)}</ul>` : ""}
      <div class="btn-row">${s.flows ? html`<button type="button" class="btn" data-limits-open>Limits</button>` : ""}<button type="button" class="btn" data-pause-all>${s.paused ? "Resume all" : "Pause all"}</button></div>
    </div>`;
  },
  events: {
    "click [data-tile=au]": (e, el, ctx) => { ctx.state.tile = ctx.keep.tile = tileToggle(ctx.state.tile, el.dataset.key, "all"); ctx.rerender(); },
    "click [data-folder-pick]": (e, el, ctx) => {
      const s = ctx.state;
      const pick = (k) => { s.folder = ctx.keep.folder = k; ctx.rerender(); };
      actionSheet("Folder", [[{ label: "All folders", icon: "list", run: () => pick(null) }], folderList(s).map((f) => ({ label: `${f.label} (${rowsOf(s).filter((x) => x.folder === f.key).length})`, icon: "list", data: { "folder-key": f.key }, run: () => pick(f.key) }))]);
    },
    "rs-hold [data-flow-more]": (e, el, ctx) => {
      const id = el.getAttribute("data-flow-more");
      const f = ctx.state.flows.flows.find((x) => x.id === id);
      if (!f) return;
      actionSheet(f.name, [
        [{ label: "Edit", icon: "edit", href: `#/automations/flow/${id}` }, { label: "Run history", icon: "clock", href: `#/automations/flow/${id}/runs` },
          { label: "Duplicate", icon: "copy", run: async () => { try { await ctx.api(`/automations/flows/${id}/duplicate`, { method: "POST", body: {} }); toast("Copied (off)"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); } } },
          { label: "Move to folder", icon: "list", data: { "flow-move": id }, run: () => moveSheet(ctx, id) }],
        [{ label: "Delete", icon: "trash", danger: true, run: async () => {
          if (!(await confirmSheet("Runs in flight stop at their next step.", { title: `Delete ${f.name}?`, yes: "Delete", danger: true }))) return;
          try { await ctx.api(`/automations/flows/${id}`, { method: "DELETE" }); toast("Deleted"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
        } }],
      ]);
    },
    "click [data-pause-all]": async (e, el, ctx) => {
      const s = ctx.state;
      if (!s.paused && !(await confirmSheet("No automation runs until you resume. Messages people send by hand still go.", { title: "Pause every automation?", yes: "Pause all", danger: true }))) return;
      try { await ctx.api(s.paused ? "/automations/resume" : "/automations/pause", { method: "POST", body: {} }); toast(s.paused ? "Automations resumed" : "Automations paused"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-new-flow]": (e, el, ctx) => newSheet(ctx.state, ctx),
    "click [data-limits-open]": (e, el, ctx) => limitsSheet(ctx.state, ctx),
    "click [data-flow-toggle]": async (e, el, ctx) => {
      const id = el.getAttribute("data-flow-toggle");
      const on = el.getAttribute("aria-checked") !== "true";
      el.disabled = true;
      try {
        await ctx.api(`/automations/flows/${encodeURIComponent(id)}/${on ? "resume" : "pause"}`, { method: "POST", body: {} });
        el.setAttribute("aria-checked", String(on));
        const f = ctx.state.flows.flows.find((x) => x.id === id);
        if (f) f.enabled = on;
        toast(on ? "On" : "Paused");
      } catch (err) { toast(err.message, { bad: true }); }
      el.disabled = false;
    },
    "click [data-toggle]": async (e, el, ctx) => {
      const key = el.getAttribute("data-toggle");
      const on = el.getAttribute("aria-checked") !== "true";
      el.disabled = true;
      try {
        await ctx.api(`/automations/${encodeURIComponent(key)}`, { method: "PATCH", body: { enabled: on } });
        el.setAttribute("aria-checked", String(on));
        const a = ctx.state.automations.find((x) => x.key === key);
        if (a) a.settings = { ...(a.settings || {}), enabled: on };
        toast(on ? "On" : "Off");
      } catch (err) { toast(err.message, { bad: true }); }
      el.disabled = false;
    },
    "click [data-open]": (e, el, ctx) => {
      const a = ctx.state.automations.find((x) => x.key === el.getAttribute("data-open"));
      if (a) editSheet(a, ctx, ctx.state.templates);
    },
  },
};
