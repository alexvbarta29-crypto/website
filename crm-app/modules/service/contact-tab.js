// The contact's Requests card (the Rotor guide's C23: Service → Requests
// with a +): their requests, newest first, each opening the request.
// Track 2's contact page draws it from this part (cards()).

import { html, listCard, listRow } from "../../core/ui.js";
import { ago } from "../../core/format.js";
import { ensureStyles, STATUS, STATUS_TONE, SOURCE } from "./kit.js";

const row = (r) => listRow({
  title: (r.services || []).length ? r.services.join(", ") : "A request", sub: [SOURCE[r.source] || r.source, ago(r.created_at)].join(" · "),
  pill: { label: STATUS[r.status] || r.status, tone: STATUS_TONE[r.status] || "grey" }, href: "#/requests/" + encodeURIComponent(r.id),
});

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("requests:read")) return { denied: true };
    const r = await ctx.api(`/requests/contacts/${encodeURIComponent(params.id)}`, { cache: false });
    return { id: params.id, rows: r.data || [] };
  },
  cards(s, ctx) {
    if (!s || s.denied) return [];
    return [{ key: "requests", tab: "details", title: "Requests", count: s.rows.length || null, empty: "No requests yet",
      add: ctx.can("requests:write") ? { label: "New request", short: "New Request", href: "#/requests/new/" + encodeURIComponent(s.id) } : null,
      body: s.rows.length ? listCard(s.rows.map(row), { label: "Requests" }) : null }];
  },
  actions(s, ctx) {
    if (!s || s.denied || !ctx.can("requests:write")) return [];
    return [{ key: "request", label: "New request", icon: "clipboard", href: "#/requests/new/" + encodeURIComponent(s.id) }];
  },
  render(s) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Requests are for the office.</p></div>`;
    return s.rows.length ? listCard(s.rows.map(row), { label: "Requests" }) : html`<p class="muted small">No requests yet.</p>`;
  },
};
