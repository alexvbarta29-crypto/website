// Jobs (design §9.2; the Rotor guide's SJ1-SJ8): Rotor's tile row (each
// tile the filter, count and $): Open · Today · Tomorrow · Next week · Next
// month · Past week · Past month · Overdue · Pending (no visit yet) · In
// progress · Paid · Done · Cancelled (this year). Then Row2 rows: the name
// and the total; the number, the next date, the kind, the people's
// initials; "Due $X" when its invoice still owes; the status pill. One
// round action: ▷ for the visit's own people on its day (opens the visit's
// step), ✓ Mark done for the office when every visit is done. A long press
// holds the rest (Book, Mark done, Cancel, Open customer). The search
// narrows by name, number or title.

import { html, attrs, icon, tileRow, tileToggle, listRow, listCard, actionSheet, toast, confirmSheet } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money, dateShort, plural } from "../../core/format.js";
import { ensureStyles, officeView, kindLabel, STALE, loadUsers, userById, reasonSheet } from "./office-kit.js";

const JOB_WORD = { unscheduled: "To book", scheduled: "Booked", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" };
const JOB_TONE = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "red" };
// an old link's ?status= (Home's "Stale jobs", the drawer's To book) → its tile
const OLD = { open: "open", stale: "overdue", done: "done", cancelled: "cancelled", unscheduled: "pending" };
const OPEN = ["unscheduled", "scheduled", "in_progress"];
const initials = (u) => String((u && u.name) || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

async function fetchRows(ctx, s) {
  const r = await ctx.api(`/jobs/stats?tile=${encodeURIComponent(s.tile)}`, { cache: false });
  s.rows = (r.data && r.data.rows) || [];
  s.tiles = (r.data && r.data.tiles) || [];
  s.today = (r.data && r.data.today) || null;
  s.stale = !!(r.meta && r.meta.stale);
}

export default {
  title: "Jobs",
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
    const asked = OLD[q.get("status")] || (q.get("tile") && /^[a-z_]+$/.test(q.get("tile")) ? q.get("tile") : null);
    const s = { tile: ctx.keep.tile || asked || "open", q: ctx.keep.q || "", rows: [], tiles: [] };
    const [users] = await Promise.all([loadUsers(ctx).catch(() => []), fetchRows(ctx, s)]);
    s.users = users;
    return s;
  },
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") ? null : { label: "New job", run: () => ctx.go("/jobs/new") }),
  render(s, ctx) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><div class="art">${icon("schedule")}</div><h2>Not for this login</h2><p>Jobs are for the office.</p></div></div>`;
    const w = s.q.trim().toLowerCase();
    const rows = w ? s.rows.filter((r) => [r.cn, r.n, r.t].some((x) => String(x || "").toLowerCase().includes(w))) : s.rows;
    const shown = rows.slice(0, 200);
    const me = ctx.user && ctx.user.id;
    const when = (r) => (r.nv ? dateShort(r.nv) : r.tm && r.st === "unscheduled" ? `due ${r.tm}` : r.done ? `done ${dateShort(r.done)}` : "");
    const tiles = (s.tiles || []).map((t) => ({ key: t.key, label: t.label, value: t.count, money: t.cents ? t.cents : null, tone: t.key === "overdue" && t.count ? "red" : null }));
    const row = (r) => {
      const open = OPEN.includes(r.st);
      // ▷ for the visit's own people on its day; ✓ for the office once every visit is done
      const mine = open && r.nv && r.nv === s.today && (r.a || []).includes(me) && ctx.can("visits:work", { type: "visit" });
      const ready = open && !r.nv && r.lv && r.st !== "unscheduled" && ctx.can("schedule:write");
      const who = (r.a || []).slice(0, 3).map((id) => initials(userById(s.users, id))).join(" ");
      return listRow({
        title: r.cn || "Customer", amount: r.bill !== false && r.tot ? r.tot : null,
        sub: [r.n, when(r), r.k !== "standard" ? kindLabel(r.k) : null, who || null, r.stale ? STALE[r.stale] || r.stale : null].filter(Boolean).join(" · "),
        tag: r.due > 0 ? `Due ${money(r.due)}` : null, edge: r.due > 0 && r.st === "completed" ? "red" : r.stale ? "amber" : null,
        pill: { label: JOB_WORD[r.st] || r.st, tone: JOB_TONE[r.st] || "grey" }, href: "#/jobs/" + encodeURIComponent(r.id),
        action: mine ? { icon: "chevright", label: `Start the visit for ${r.cn || "the customer"}`, tone: "red", data: { "job-start": r.id } }
          : ready ? { icon: "check", label: `Mark ${r.n} done`, tone: "green", data: { "job-done": r.id } } : null,
        hold: { "job-more": r.id },
      });
    };
    return html`<div class="stack wk wk-jobs sv-jobs">
      ${tileRow(tiles, { name: "jobs", on: s.tile, label: "Jobs" })}
      <label class="${"field wk-filter find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search jobs</span><input type="search" name="q" placeholder="Name, number or title" autocomplete="off" ${attrs({ value: s.q })}></label>
      ${listCard(shown.map(row), { label: "Jobs", empty: w ? "Nothing matches. Try another name or number." : s.tile === "overdue" ? "Nothing overdue. Jobs booked for a day that went by, or under way for days, show up here." : s.tile === "pending" ? "Every job has a visit." : "No jobs here." })}
      <p class="small muted wk-count">${plural(rows.length, "job")}${rows.length > shown.length ? `, the first ${shown.length} shown` : ""}</p>
      ${s.stale ? html`<p class="foot-note">This list is being rebuilt; a change from the last minute may be missing.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { if (!s.denied) findButton(view, ctx, "Search jobs"); },
  events: {
    "click [data-tile=jobs]": async (e, el, ctx) => { const s = ctx.state; s.tile = tileToggle(s.tile, el.dataset.key, "open"); ctx.keep.tile = s.tile; await fetchRows(ctx, s).catch(() => { s.rows = []; }); ctx.rerender(); },
    "click [data-job-start]": async (e, el, ctx) => {
      e.preventDefault();
      try {
        const d = (await ctx.api(`/jobs/${encodeURIComponent(el.dataset.jobStart)}`, { cache: false })).data;
        const me = ctx.user && ctx.user.id;
        const v = (d.visits || []).find((x) => ["scheduled", "en_route", "in_progress", "paused"].includes(x.status) && (x.assignee_ids || []).includes(me)) || (d.visits || [])[0];
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
    "rs-hold [data-job-more]": (e, el, ctx) => {
      const r = ctx.state.rows.find((x) => x.id === el.dataset.jobMore);
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
    },
    "input [name=q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.t);
      ctx.keep.t = setTimeout(() => { ctx.rerender(); const i = document.querySelector("#view [name=q]"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
    },
  },
};
