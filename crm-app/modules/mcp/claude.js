// Settings → Claude connector (M7c, design §6.9, §4.9): how to let Claude
// work in the CRM. Two ways in, both made here:
//   - claude.ai (a custom connector takes a link only): a connector link,
//     read-only. Claude reads customers, the schedule, quotes, plans,
//     invoices, messages and reports.
//   - Claude Code, Claude Desktop or the API (they send a header): a key
//     that may also ASK (a text, a task, a quote, a job, a deal move). Every
//     ask waits for an owner's tap in Approvals; nothing happens before.
// A key is shown once. The list below revokes them.

import { html, icon, toast, confirmSheet, attrs } from "../../core/ui.js";
import { ago, dateShort, plural } from "../../core/format.js";

const copy = async (text, what) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (e) { toast("Press and hold to copy it."); }
};
const copyBox = (value, label, key) => html`<div class="copy-box"><input type="text" readonly ${attrs({ value, "aria-label": label })}><button type="button" class="btn dark" ${attrs({ "data-copy": key })}>${icon("copy")}Copy</button></div>`;

function made(s) {
  const m = s.made;
  if (!m) return "";
  if (m.kind === "path") {
    const url = s.info.path_url_template.replace("{key}", m.key);
    return html`<div class="card stack" data-made>
      <div class="warn-box">Copy it now. It's shown only this once.</div>
      ${copyBox(url, "Connector link", "link")}
      <ol class="small steps">
        <li>On claude.ai open Settings, then Connectors.</li>
        <li>Tap Add custom connector. Name it Barta CRM and paste the link. Tap Add.</li>
        <li>In a chat, open the tools menu and switch Barta CRM on.</li>
      </ol>
      <p class="small muted">Then ask things like "what did we bill last month?" or "who's on the schedule Thursday?".</p>
    </div>`;
  }
  const cmd = `claude mcp add --transport http barta-crm ${s.info.url} --header "Authorization: Bearer ${m.key}"`;
  return html`<div class="card stack" data-made>
    <div class="warn-box">Copy it now. It's shown only this once.</div>
    ${copyBox(m.key, "API key", "key")}
    <p class="small"><b>Claude Code:</b> run this once on the computer.</p>
    ${copyBox(cmd, "Command", "cmd")}
    <p class="small"><b>Anything else</b> (Claude Desktop, the API): the server is ${s.info.url} and the key goes in the header Authorization: Bearer, then the key.</p>
  </div>`;
}

export default {
  title: "Claude connector",
  async load(params, ctx) {
    const [info, keys] = await Promise.all([ctx.api("/mcp/connect", { cache: false }), ctx.api("/api-keys", { cache: false })]);
    return { info: info.data, keys: keys.data || [], scopes: (keys.meta && keys.meta.scopes) || { read: [], write: [], defaults: [] }, made: null };
  },
  render(s, ctx) {
    const canAsk = s.info.ask_scopes.length > 0;
    const claudeKeys = s.keys.filter((k) => k.kind !== "backup");
    return html`<div class="stack">
      <div class="card"><p class="small">Claude can look things up in the CRM and ask for things to be done. It only sees what you can see. Anything it asks for (a text, a task, a quote, a job) waits for an owner's OK under Approvals: nothing happens before that.</p></div>

      <div class="section-h">claude.ai (read only)</div>
      <div class="card stack">
        <p class="small">A connector link lets Claude read customers, the schedule, quotes, plans, invoices, messages and reports. It can't ask for changes, and it can make 30 calls a minute.</p>
        <button type="button" class="btn primary block" data-make="path">${icon("link")}Make a connector link</button>
      </div>
      ${s.made && s.made.kind === "path" ? made(s) : ""}

      ${canAsk ? html`<div class="section-h">Claude Code, Claude Desktop or the API</div>
      <div class="card stack">
        <p class="small">A key Claude sends in a header can read the same things and also ask for ${plural(s.info.tools.ask.length, "kind of change", "kinds of change")}. Each ask lands in Approvals for an owner to approve or reject.</p>
        <button type="button" class="btn dark block" data-make="header">${icon("key")}Make a key that can ask</button>
      </div>
      ${s.made && s.made.kind === "header" ? made(s) : ""}` : ""}

      <div class="section-h">Your keys</div>
      ${claudeKeys.length ? html`<ul class="list">${claudeKeys.map((k) => html`<li><div class="row">${icon(k.kind === "path" ? "link" : "key")}<span class="who"><span class="nm">${k.name}</span><span class="sub">${k.kind === "path" ? "Connector link" : "Header key"} · …${k.last4} · ${k.last_used_at ? "used " + ago(k.last_used_at) : "never used"}${k.expires_at ? " · ends " + dateShort(k.expires_at) : ""}</span></span><span class="end"><button type="button" class="btn danger" ${attrs({ "data-revoke": k.id })}>Revoke</button></span></div></li>`)}</ul>`
        : html`<div class="card muted small">No keys yet.</div>`}

      <details class="card more"><summary>What Claude can do (${s.info.tools.read.length + s.info.tools.ask.length} tools)</summary>
        <p class="small"><b>Look up:</b> ${s.info.tools.read.join(", ").replace(/_/g, " ")}</p>
        <p class="small"><b>Ask for (waits for an owner):</b> ${s.info.tools.ask.join(", ").replace(/_/g, " ")}</p>
      </details>
      <p class="small muted">Texts and emails Claude asks for stay in the Outbox until texting is switched on. A link or key you no longer use: revoke it.</p>
    </div>`;
  },
  events: {
    "click [data-make]": async (e, btn, ctx) => {
      const kind = btn.getAttribute("data-make");
      const s = ctx.state;
      btn.disabled = true;
      try {
        const scopes = kind === "path" ? undefined : [...new Set([...s.scopes.defaults, ...s.info.ask_scopes])];
        const r = await ctx.api("/api-keys", { method: "POST", body: { name: kind === "path" ? "Claude.ai connector" : "Claude (can ask)", kind, expires_days: 365, ...(scopes ? { scopes } : {}) } });
        s.made = { kind, key: r.data.key };
        s.keys = [{ ...r.data, key: undefined }, ...s.keys];
        ctx.rerender();
      } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-copy]": (e, btn) => {
      const k = btn.getAttribute("data-copy");
      const input = btn.closest(".copy-box").querySelector("input");
      if (input) copy(input.value, k === "link" ? "Link" : k === "cmd" ? "Command" : "Key");
    },
    "click [data-revoke]": async (e, btn, ctx) => {
      if (!(await confirmSheet("Claude stops getting in with it at once.", { title: "Revoke this key?", yes: "Revoke", danger: true }))) return;
      try { await ctx.api(`/api-keys/${encodeURIComponent(btn.getAttribute("data-revoke"))}`, { method: "DELETE" }); toast("Revoked"); ctx.state.made = null; ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
