// Jobs (design §9.2; Rotor's Service → Jobs, the Rotor guide's SJ1-SJ8),
// laid out like Rotor's: the tile row Today · Tomorrow · Past week · Past
// month · Next week · Next month (each tile the filter, its count and $);
// then the search, the filter (Open, In progress, Paid, Done, Cancelled and
// every tile) and the sort, and Rotor's "⚠ Overdue | Pending Jobs" pair;
// then the table: Customer · Job # (which job of its plan) · Address ·
// Start date · Status · Line items · Total · Due, and the round ▷ ✓ ⋮.
// On a phone the same table is two-line rows (the kit's dataTable): the
// name and the total, the number and the date, "Due $X" when its invoice
// still owes, the status pill; one round action: ▷ for the visit's own
// people on its day (opens the visit's step), ✓ Mark done for the office
// when every visit is done; a long press holds the rest (Book, Mark done,
// Cancel, Open customer), the ⋮ on a desk. The search narrows by name,
// number, title or address.

import { html, attrs, icon, rnd, tileRow, tileToggle, dataTable, actionSheet, filterSheet, toast, confirmSheet } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money, dateShort, clock, plural } from "../../core/format.js";
import { ensureStyles, officeView, kindLabel, STALE, loadUsers, userById, reasonSheet } from "./office-kit.js";
import { ensureStyles as svStyles } from "../service/kit.js";

const JOB_WORD = { unscheduled: "To book", scheduled: "Booked", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" };
const JOB_TONE = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "red" };
// an old link's ?status= (Home's "Stale jobs", the drawer's To book) → its tile
const OLD = { open: "open", stale: "overdue", done: "done", cancelled: "cancelled", unscheduled: "pending" };
const OPEN = ["unscheduled", "scheduled", "in_progress"];
// Rotor's six tiles, in Rotor's order; Overdue and Pending sit by the search; the rest are in the filter
export const ROTOR_TILES = ["today", "tomorrow", "past_week", "past_month", "next_week", "next_month"];
const SORTS = [["date", "Start date"], ["customer", "Customer"], ["total", "Total"], ["due", "Due"]];
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? DAY.format(new Date(d + "T12:00:00Z")) : "");     // "Nov 18" (Rotor's)
const initials = (u) => String((u && u.name) || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
// "1st job" of a plan (Rotor's line under the number), "One-time" otherwise
export const ordinal = (n) => { const k = Number(n); if (!(k > 0)) return ""; const t = k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] || "th"; return `${k}${t} job`; };

async function fetchRows(ctx, s) {
  const r = await ctx.api(`/jobs/stats?tile=${encodeURIComponent(s.tile)}`, { cache: false });
  s.rows = (r.data && r.data.rows) || [];
  s.tiles = (r.data && r.data.tiles) || [];
  s.today = (r.data && r.data.today) || null;
  s.stale = !!(r.meta && r.meta.stale);
}

const tileOf = (s, key) => (s.tiles || []).find((t) => t.key === key) || { key, label: key, count: 0, cents: 0 };
// what a row still owes: its invoices' balance; an open billed job with no invoice yet owes its total
const dueOf = (r) => (r.due > 0 ? r.due : OPEN.includes(r.st) && r.bill !== false && r.tot > 0 ? r.tot : null);
const sorted = (rows, by) => {
  if (!by || by === "date") return rows;
  const k = { customer: (a, b) => String(a.cn || "").localeCompare(String(b.cn || "")), total: (a, b) => (b.tot || 0) - (a.tot || 0), due: (a, b) => (dueOf(b) || 0) - (dueOf(a) || 0) }[by];
  return k ? rows.slice().sort(k) : rows;
};

export default {
  title: "Jobs",
  async load(params, ctx) {
    ensureStyles();
    svStyles();
    if (!officeView()) return { denied: true };
    const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
    const asked = OLD[q.get("status")] || (q.get("tile") && /^[a-z_]+$/.test(q.get("tile")) ? q.get("tile") : null);
    const s = { tile: ctx.keep.tile || asked || "open", q: ctx.keep.q || "", sort: ctx.keep.sort || "date", rows: [], tiles: [] };
    const [users] = await Promise.all([loadUsers(ctx).catch(() => []), fetchRows(ctx, s)]);
    s.users = users;
    return s;
  },
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") ? null : { label: "Add Job", run: () => ctx.go("/jobs/new") }),
  render(s, ctx) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><div class="art">${icon("schedule")}</div><h2>Not for this login</h2><p>Jobs are for the office.</p></div></div>`;
    const w = s.q.trim().toLowerCase();
    const rows = sorted(w ? s.rows.filter((r) => [r.cn, r.n, r.t, r.ad].some((x) => String(x || "").toLowerCase().includes(w))) : s.rows, s.sort);
    const shown = rows.slice(0, 200);
    const me = ctx.user && ctx.user.id;
    const writer = ctx.can("schedule:write");
    const tiles = ROTOR_TILES.map((k) => tileOf(s, k)).map((t) => ({ key: t.key, label: t.label, value: t.count, money: t.cents || 0 }));
    const od = tileOf(s, "overdue"), pend = tileOf(s, "pending");
    const extra = !ROTOR_TILES.includes(s.tile) && !["open", "overdue", "pending"].includes(s.tile) ? tileOf(s, s.tile) : null;
    const startOf = (r) => (r.nv ? `${day(r.nv)}${r.at ? ` · ${clock(r.at)}` : ""}` : r.tm && r.st === "unscheduled" ? `due ${r.tm}` : r.done ? `done ${dateShort(r.done)}` : r.lv ? day(r.lv) : "");
    const row = (r) => {
      const open = OPEN.includes(r.st);
      // ▷ for the visit's own people on its day (the office opens the next visit from a desk); ✓ for the office once every visit is done
      const mine = open && r.nv && r.nv === s.today && (r.a || []).includes(me) && ctx.can("visits:work", { type: "visit" });
      const startable = open && (r.nv || r.lv) && (mine || writer);
      const ready = open && !r.nv && r.lv && r.st !== "unscheduled" && writer;
      const who = (r.a || []).slice(0, 3).map((id) => initials(userById(s.users, id))).join(" ");
      const due = dueOf(r);
      const ord = r.pl ? ordinal(r.po) || "Plan job" : "One-time";
      return {
        cells: {
          who: { text: r.cn || "Customer", sub: [r.k !== "standard" ? kindLabel(r.k) : null, who || null, r.stale ? STALE[r.stale] || r.stale : null].filter(Boolean).join(" · ") },
          num: html`${r.n}<span class="wk-jord">${ord}</span>${r.due > 0 ? html`<span class="wk-jdue">Due ${money(r.due)}</span>` : ""}`,
          ad: r.ad || "", start: startOf(r),
          st: { label: JOB_WORD[r.st] || r.st, tone: JOB_TONE[r.st] || "grey" },
          li: r.li === undefined || r.li === null ? "" : String(r.li),
          tot: r.bill !== false && r.tot ? r.tot : null, due: due === null ? null : due,
        },
        href: "#/jobs/" + encodeURIComponent(r.id),
        edge: r.due > 0 && r.st === "completed" ? "red" : r.stale ? "amber" : null,
        action: [
          { icon: "play", label: `Start the visit for ${r.cn || "the customer"}`, tone: mine ? "red" : "grey", data: { "job-start": r.id }, wide: !mine, disabled: !startable },
          { icon: "check", label: `Mark ${r.n} done`, tone: ready ? "green" : "grey", data: { "job-done": r.id }, wide: !ready, disabled: !ready },
          { icon: "more", label: `More for ${r.n}`, popup: true, data: { "job-menu": r.id }, wide: true },
        ],
        hold: { "job-more": r.id },
      };
    };
    const empty = w ? "Nothing matches. Try another name, number or street." : s.tile === "overdue" ? "Nothing overdue. Jobs booked for a day that went by, or under way for days, show up here." : s.tile === "pending" ? "Every job has a visit." : "No jobs here.";
    return html`<div class="stack wk wk-jobs sv-jobs">
      ${tileRow(tiles, { name: "jobs", on: s.tile, label: "Jobs" })}
      <div class="wk-jbar">
        <label class="${"field wk-filter find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search jobs</span><input type="search" name="q" placeholder="Search jobs..." autocomplete="off" ${attrs({ value: s.q })}></label>
        <span class="wk-jtools">${rnd("filter", extra ? `Filter: ${extra.label}` : "Filter", { tone: "grey", sm: true, popup: true, pressed: !!extra, data: { "jobs-filter": true } })}${rnd("sort", `Sort: ${(SORTS.find((x) => x[0] === s.sort) || SORTS[0])[1]}`, { tone: "grey", sm: true, popup: true, pressed: s.sort !== "date", data: { "jobs-sort": true } })}</span>
        <span class="wk-jsplit" role="group" aria-label="Overdue and pending jobs">
          <button type="button" ${attrs({ class: "wk-jsp od" + (od.count ? " red" : ""), "data-tile": "jobs", "data-key": "overdue", "aria-pressed": String(s.tile === "overdue") })}>${icon("flag")}<b class="num">${String(od.count || 0)}</b> Overdue</button>
          <button type="button" ${attrs({ class: "wk-jsp", "data-tile": "jobs", "data-key": "pending", "aria-pressed": String(s.tile === "pending") })}><b class="num">${String(pend.count || 0)}</b> Pending Jobs</button>
        </span>
      </div>
      ${extra ? html`<p class="wk-jshow"><span>Showing <b>${extra.label}</b>${extra.cents ? ` · ${money(extra.cents)}` : ""}</span><button type="button" class="btn sm" data-tile="jobs" ${attrs({ "data-key": extra.key })}>Show open jobs</button></p>` : ""}
      <div class="wk-jtable">${dataTable({
        label: "Jobs",
        columns: [
          { key: "who", label: "Customer", kind: "title" },
          { key: "num", label: "Job #", kind: "text", width: "minmax(92px,.8fr)" },
          { key: "ad", label: "Address", kind: "text", width: "minmax(0,1.2fr)" },
          { key: "start", label: "Start date", kind: "date", width: "minmax(136px,1fr)" },
          { key: "st", label: "Status", kind: "status", width: "minmax(104px,.7fr)" },
          { key: "li", label: "Line items", kind: "num", width: "64px" },
          { key: "tot", label: "Total", kind: "money", width: "minmax(84px,.6fr)" },
          { key: "due", label: "Due", kind: "money", width: "minmax(84px,.6fr)" },
        ],
        rows: shown.map(row),
        empty,
      })}</div>
      <p class="small muted wk-count">${plural(rows.length, "job")}${rows.length > shown.length ? `, the first ${shown.length} shown` : ""}</p>
      ${s.stale ? html`<p class="foot-note">This list is being rebuilt; a change from the last minute may be missing.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { if (!s.denied) findButton(view, ctx, "Search jobs"); },
  events: {
    "click [data-tile=jobs]": async (e, el, ctx) => { const s = ctx.state; s.tile = tileToggle(s.tile, el.dataset.key, "open"); ctx.keep.tile = s.tile; await fetchRows(ctx, s).catch(() => { s.rows = []; }); ctx.rerender(); },
    "click [data-jobs-filter]": async (e, el, ctx) => {
      const s = ctx.state;
      const all = (s.tiles || []).map((t) => [t.key, `${t.label} (${t.count})`]);
      const v = await filterSheet({ title: "Show", values: { show: s.tile }, count: (x) => tileOf(s, x.show || "open").count, groups: [{ key: "show", label: "Jobs", type: "radio", default: "open", options: all }] });
      if (!v) return;
      s.tile = v.show || "open"; ctx.keep.tile = s.tile;
      await fetchRows(ctx, s).catch(() => { s.rows = []; });
      ctx.rerender();
    },
    "click [data-jobs-sort]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await filterSheet({ title: "Sort", values: { sort: s.sort }, count: s.rows.length, groups: [{ key: "sort", label: "Sort by", type: "sort", default: "date", options: SORTS }] });
      if (!v) return;
      s.sort = ctx.keep.sort = v.sort || "date";
      ctx.rerender();
    },
    "click [data-job-start]": async (e, el, ctx) => {
      e.preventDefault();
      try {
        const d = (await ctx.api(`/jobs/${encodeURIComponent(el.dataset.jobStart)}`, { cache: false })).data;
        const me = ctx.user && ctx.user.id;
        const live = (x) => ["scheduled", "en_route", "in_progress", "paused"].includes(x.status);
        const vs = d.visits || [];
        const v = vs.find((x) => live(x) && (x.assignee_ids || []).includes(me)) || vs.find(live) || vs[0];
        ctx.go(v ? `/visits/${encodeURIComponent(v.id)}` : `/jobs/${encodeURIComponent(el.dataset.jobStart)}`);
      } catch (err) { toast(err.message || "That job didn't open.", { bad: true }); }
    },
    "click [data-job-done]": async (e, el, ctx) => {
      e.preventDefault();
      if (!(await confirmSheet("Mark the job done?", { title: "Mark done", yes: "Mark done" }))) return;
      try { await ctx.api(`/jobs/${encodeURIComponent(el.dataset.jobDone)}/complete`, { method: "POST", body: {} }); toast("Marked done"); }
      catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
      ctx.refresh();
    },
    "click [data-job-menu]": (e, el, ctx) => { e.preventDefault(); jobMenu(ctx, el.dataset.jobMenu); },
    "rs-hold [data-job-more]": (e, el, ctx) => jobMenu(ctx, el.dataset.jobMore),
    "input [name=q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.t);
      ctx.keep.t = setTimeout(() => { ctx.rerender(); const i = document.querySelector("#view [name=q]"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
    },
  },
};

// The row's "..." (a long press, or the ⋮ on a desk): Open, Book a visit, Mark done, Open customer, Cancel job.
function jobMenu(ctx, id) {
  const r = ctx.state.rows.find((x) => x.id === id);
  if (!r) return;
  const open = OPEN.includes(r.st);
  const w = ctx.can("schedule:write");
  actionSheet(r.cn || "Job", [
    [{ label: "Open the job", icon: "doc", href: "#/jobs/" + encodeURIComponent(r.id) },
      w && open && { label: "Book a visit", icon: "cal", href: "#/jobs/" + encodeURIComponent(r.id) },
      w && open && r.st !== "unscheduled" && { label: "Mark done", icon: "check", run: async () => { try { await ctx.api(`/jobs/${encodeURIComponent(r.id)}/complete`, { method: "POST", body: {} }); toast("Marked done"); } catch (err) { toast(err.message || "That didn't save.", { bad: true }); } ctx.refresh(); } }],
    [r.c && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(r.c) }],
    [w && open && { label: "Cancel job", icon: "close", danger: true, run: async () => {
      const x = await reasonSheet({ title: "Cancel this job", label: "Why? (its open visits are cancelled too)", yes: "Cancel the job" });
      if (!x) return;
      try { await ctx.api(`/jobs/${encodeURIComponent(r.id)}/cancel`, { method: "POST", body: { reason: x.reason } }); toast("Cancelled"); } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
      ctx.refresh();
    } }],
  ]);
}
