// Plans (design §9.2 "Plans"; the Rotor guide's SP1-SP3, SP9): Rotor's
// health tiles, each the filter: Projected ARR (info: Home's math, a year
// of each recurring plan's visits) · Active · Awaiting signature · Card
// needed · Autopay off · Failed payments · After agreement · Cancel
// requests (the Save center) · Due this month · Paused · Ending ·
// Clawbacks · Cancelled · Ended, and a Lights tile (the season board).
// Row2 rows: the customer and the plan's year; the plan, its length, the
// next visit's month, Autopay; "Not signed" when the agreement isn't; the
// status. Returning keeps the tile, search and scroll.

import { html, attrs, tileRow, tileToggle, listRow, listCard } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money } from "../../core/format.js";
import { ensureStyles, STATUS, pendingText, monthLabel } from "./kit.js";

const TONE = { pending: "amber", active: "green", paused: "blue", cancelling: "amber", cancelled: "red", expired: "grey", draft: "grey" };
const LIVE = ["pending", "active", "paused", "cancelling"];
const SIGNED = ["signed", "imported_unknown"];
export const TILES = [["active", "Active"], ["signature", "Awaiting signature"], ["card", "Card needed"], ["autopay_off", "Autopay off"], ["failed", "Failed payments"], ["after", "After agreement"],
  ["save", "Cancel requests"], ["due", "Due this month"], ["paused", "Paused"], ["cancelling", "Ending"], ["clawback", "Clawbacks"], ["cancelled", "Cancelled"], ["expired", "Ended"]];

// Which tiles a plan row is in (pure). month: this month (YYYY-MM).
export function planTiles(r, month) {
  const out = [];
  if (["active", "paused", "cancelling", "cancelled", "expired"].includes(r.st)) out.push(r.st);
  const live = LIVE.includes(r.st);
  if (live && ((r.pr || []).includes("signature") || ["sent", "viewed"].includes(r.ag))) out.push("signature");
  if (live && (r.pr || []).includes("card")) out.push("card");
  if (["active", "cancelling"].includes(r.st) && !r.ap && r.k !== "lights_annual") out.push("autopay_off");
  if (r.pf) out.push("failed");
  if (r.aa && ["active", "cancelling", "paused"].includes(r.st)) out.push("after");
  if (r.sr) out.push("save");
  if (["active", "cancelling"].includes(r.st) && r.due && r.due <= month) out.push("due");
  if (r.cb) out.push("clawback");
  return out;
}

// Row2: the customer and the plan's year; the plan, its length, what's next, Autopay; the status.
export function planRow2(r) {
  const extra = r.st === "pending" ? `waiting for ${pendingText(r.pr) || "the agreement"}` : r.nx ? `next ${monthLabel(r.nx)}` : "";
  const year = r.ay !== undefined && r.ay !== null ? r.ay : null;
  return listRow({
    title: r.cn || "No name", amount: year !== null ? `${money(year)}/yr` : r.sv ? r.sv : null,
    sub: [r.nm, r.k !== "lights_annual" && r.tm ? `${r.tm} mo` : null, extra || null, r.ap ? "Autopay" : null].filter(Boolean).join(" · "),
    tag: LIVE.includes(r.st) && r.st !== "pending" && !SIGNED.includes(r.ag) ? "Not signed" : r.sr ? "Wants to cancel" : null,
    edge: r.pf || r.sr === 2 ? "red" : null,
    pill: { label: STATUS[r.st] || r.st, tone: TONE[r.st] || "grey" }, href: "#/plans/" + encodeURIComponent(r.id),
  });
}

async function load(params, ctx) {
  ensureStyles();
  const asked = (location.hash.match(/status=([a-z_]+)/) || [])[1];
  const tile = ctx.keep.tile || (asked === "pending" ? "signature" : asked) || "active";
  const r = await ctx.api("/plans", { cache: false });
  const m = r.meta || {};
  return { rows: r.data || [], arr: m.arr ?? null, month: String(m.today || "").slice(0, 7) || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date()).slice(0, 7), tile: TILES.some(([k]) => k === tile) ? tile : "active", q: ctx.keep.q || "" };
}

function visible(s) {
  const q = s.q.trim().toLowerCase();
  return s.rows.filter((r) => planTiles(r, s.month).includes(s.tile)).filter((r) => !q || `${r.cn} ${r.nm}`.toLowerCase().includes(q));
}

export default {
  load,
  action: (s, ctx) => (ctx.can("plans:write") ? { label: "New plan", run: () => ctx.go("/plans/new") } : null),
  render(s, ctx) {
    const c = Object.fromEntries(TILES.map(([k]) => [k, 0]));
    for (const r of s.rows) for (const k of planTiles(r, s.month)) c[k] = (c[k] || 0) + 1;
    const rows = visible(s);
    const RED = new Set(["failed", "save", "card", "signature"]);
    const tiles = [
      { key: "arr", label: "Projected ARR", value: s.arr === null ? "-" : money(s.arr).replace(/\.00$/, ""), info: true },
      ...TILES.filter(([k]) => ["active", "signature", "card", "autopay_off", "failed", "after", "due"].includes(k) || c[k] > 0 || k === s.tile)
        .map(([k, label]) => ({ key: k, label, value: c[k], tone: RED.has(k) && c[k] ? (k === "signature" || k === "card" ? "amber" : "red") : null })),
      ctx.can("plans:read") && { key: "lights", label: "Lights", value: "Season", href: "#/lights" },
    ];
    return html`<div class="stack rs-list-page">
      ${tileRow(tiles, { name: "plans", on: s.tile, label: "Plans" })}
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search plans</span><input type="search" data-q placeholder="Name or plan" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      ${listCard(rows.map(planRow2), { label: "Plans", empty: s.tile === "active" ? "No active plans yet. Plans sold on a quote land here once they're signed." : "Nothing here. Pick another tile." })}
      <div class="links"><a class="tile" href="#/plans/due">Visits to book</a></div>
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search plans"); },
  events: {
    "click [data-tile=plans]": (e, el, ctx) => { if (el.dataset.key === "lights") return; ctx.state.tile = ctx.keep.tile = tileToggle(ctx.state.tile, el.dataset.key, "active"); ctx.rerender(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { if (!el.isConnected) return; const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
