// Quotes (design §9.2 "Quotes"; the Rotor guide's SQ1, SQ2, SQ7): Rotor's
// tile row, each tile the filter: All · Open · Sent · Viewed · Changes
// asked · Approved · Converted (booked) · Expired · Declined · Draft ·
// Archived, with the $ of the first visits for Open, Sent and Approved.
// Then Row2 rows: the customer and the first-visit price (or the year for
// a plan); the number, plan or one-time, when it went out and an eye when
// they opened it; the status. Returning keeps the tile, search and scroll.

import { html, attrs, tileRow, tileToggle, listRow, listCard } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money, ago, dateShort } from "../../core/format.js";
import { ensureStyles, OPEN, STATUS } from "./kit.js";

const TONE = { draft: "grey", sent: "blue", viewed: "blue", changes_requested: "amber", approved: "green", converted: "green", declined: "red", archived: "grey", expired: "amber" };
export const TILES = [["all", "All"], ["open", "Open"], ["sent", "Sent"], ["viewed", "Viewed"], ["changes_requested", "Changes asked"], ["approved", "Approved"], ["converted", "Converted"], ["expired", "Expired"], ["declined", "Declined"], ["draft", "Draft"], ["archived", "Archived"]];
const MONEY_TILES = new Set(["open", "sent", "approved"]);
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

// Which tiles a quote is in (pure): expired = sent or viewed whose date to answer went by.
export function quoteTiles(r, today) {
  const out = ["all"];
  if (OPEN.includes(r.st)) out.push("open");
  if (["sent", "viewed"].includes(r.st) && r.exp && r.exp < today) out.push("expired");
  else if (r.st === "viewed") out.push("viewed", "sent");
  else out.push(r.st);
  return out;
}
export function tileCounts(rows, today) {
  const c = Object.fromEntries(TILES.map(([k]) => [k, { n: 0, cents: 0 }]));
  for (const r of rows) for (const k of quoteTiles(r, today)) if (c[k]) { c[k].n += 1; c[k].cents += r.first || 0; }
  return c;
}

// Row2: the customer and the first-visit price ($/yr for a plan); the number, plan or one-time, sent and viewed.
export function quoteRow2(r) {
  const plan = (r.k || []).includes("plan") && r.annual;
  return listRow({
    title: r.cn || "No name", amount: plan ? `${money(r.annual)}/yr` : r.first !== null && r.first !== undefined ? r.first : null,
    sub: html`${[r.n, (r.k || []).includes("plan") ? "Plan" : "One-time", r.sent ? `sent ${ago(r.sent)}` : `made ${dateShort(r.at || r.u)}`].join(" · ")}${r.viewed ? html` · <b class="q-seen">viewed ${ago(r.viewed)}</b>` : ""}`,
    pill: { label: r.st === "converted" ? "Booked" : STATUS[r.st] || r.st, tone: TONE[r.st] || "grey" }, href: "#/quotes/" + encodeURIComponent(r.id),
  });
}

async function load(params, ctx) {
  ensureStyles();
  const asked = (location.hash.match(/status=([a-z_]+)/) || [])[1];
  const tile = ctx.keep.tile || (asked === "converted" ? "converted" : asked) || "open";
  const r = await ctx.api(`/quotes?status=all`, { cache: false });
  return { rows: r.data || [], tile: TILES.some(([k]) => k === tile) ? tile : "open", q: ctx.keep.q || "", today: localToday() };
}

function visible(s) {
  const q = s.q.trim().toLowerCase();
  return s.rows.filter((r) => quoteTiles(r, s.today).includes(s.tile)).filter((r) => !q || `${r.cn} ${r.n}`.toLowerCase().includes(q));
}

export default {
  load,
  action: (s, ctx) => (ctx.can("quotes:write") ? { label: "New quote", run: () => ctx.go("/quotes/new") } : null),
  render(s, ctx) {
    const c = tileCounts(s.rows, s.today);
    const rows = visible(s);
    const tiles = TILES.filter(([k]) => ["all", "open", "sent", "viewed", "changes_requested", "approved", "converted"].includes(k) || c[k].n > 0 || k === s.tile)
      .map(([k, label]) => ({ key: k, label, value: c[k].n, money: MONEY_TILES.has(k) && c[k].cents ? c[k].cents : null, tone: k === "changes_requested" && c[k].n ? "amber" : k === "expired" && c[k].n ? "amber" : null }));
    return html`<div class="stack">
      ${tileRow(tiles, { name: "quotes", on: s.tile, label: "Quotes" })}
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search quotes</span><input type="search" data-q placeholder="Name or number" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      ${listCard(rows.map(quoteRow2), { label: "Quotes", empty: s.tile === "open" ? "No open quotes. Tap + to price a house." : "Nothing here. Pick another tile." })}
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search quotes"); },
  events: {
    "click [data-tile=quotes]": (e, el, ctx) => { ctx.state.tile = ctx.keep.tile = tileToggle(ctx.state.tile, el.dataset.key, "open"); ctx.rerender(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { if (!el.isConnected) return; const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
