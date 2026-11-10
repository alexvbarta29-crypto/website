// Time off (design §9.2 Schedule, §5.5 availability): who is off and when,
// from 30 days back on. Add whole days (first and last day) or part of one
// day; remove an entry. The schedule warns when a visit lands on someone's
// time off; it never blocks.

import { html, icon, attrs, sheet, toast, confirmSheet } from "../../core/ui.js";
import { dateShort, time } from "../../core/format.js";
import { readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { ensureStyles, officeView, loadUsers, team, userById, today, addDays, emptyCard } from "./office-kit.js";

// "Thu, Dec 24 – Sat, Dec 26" for whole days (the end is the next midnight), else the day and the hours.
export function offWhen(r) {
  const s = new Date(r.s);
  if (r.ad && r.e) {
    const last = new Date(Date.parse(r.e) - 3600000);
    const a = dateShort(s), b = dateShort(last);
    return a === b ? `${a}, all day` : `${a} – ${b}`;
  }
  return `${dateShort(s)}, ${time(s)}${r.e ? `–${time(r.e)}` : " on"}`;
}

async function fetchRows(ctx) { return (await ctx.api("/time-off", { cache: false })).data || []; }

function addSheet(ctx) {
  const s = ctx.state;
  let part = false;
  const body = () => html`<form class="form" id="wk-off" novalidate>
    <div class="err" data-form-err hidden></div>
    <label class="field" data-field="user_id"><span>Who</span><select name="user_id">${s.users.map((u) => html`<option ${attrs({ value: u.id })}>${u.name}</option>`)}</select><small class="why" hidden></small></label>
    <div class="chips" role="tablist"><button type="button" class="chip" data-part="0" ${attrs({ "aria-pressed": String(!part) })}>Whole days</button><button type="button" class="chip" data-part="1" ${attrs({ "aria-pressed": String(part) })}>Part of a day</button></div>
    ${part ? html`
      <label class="field" data-field="date"><span>Day</span><input type="date" name="date" ${attrs({ value: addDays(today(), 1) })}><small class="why" hidden></small></label>
      <div class="grid2"><label class="field" data-field="start"><span>From</span><input type="time" name="start" step="900" value="09:00"><small class="why" hidden></small></label>
      <label class="field" data-field="end"><span>To</span><input type="time" name="end" step="900" value="12:00"><small class="why" hidden></small></label></div>`
    : html`<div class="grid2"><label class="field" data-field="date"><span>First day</span><input type="date" name="date" ${attrs({ value: addDays(today(), 1) })}><small class="why" hidden></small></label>
      <label class="field" data-field="end_date"><span>Last day</span><input type="date" name="end_date" ${attrs({ value: addDays(today(), 1) })}><small class="why" hidden></small></label></div>`}
    <label class="field" data-field="reason"><span>Why (optional)</span><input name="reason" maxlength="120" placeholder="Vacation"><small class="why" hidden></small></label>
    <button type="submit" class="btn primary block">Add</button>
  </form>`;
  const sh = sheet({
    title: "Add time off",
    body: body(),
    events: {
      "click [data-part]": (e, b) => {
        const who = sh.el.querySelector("[name=user_id]").value;
        part = b.dataset.part === "1";
        sh.set(body());
        sh.el.querySelector("[name=user_id]").value = who;
      },
      "submit #wk-off": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const payload = part ? { user_id: v.user_id, date: v.date, start: v.start, end: v.end, reason: v.reason } : { user_id: v.user_id, date: v.date, end_date: v.end_date || v.date, reason: v.reason };
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try { await ctx.api("/time-off", { method: "POST", body: payload }); sh.close(); toast("Added"); ctx.refresh(); }
        catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

export default {
  title: "Time off",
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    const [rows, users] = await Promise.all([fetchRows(ctx), loadUsers(ctx).catch(() => [])]);
    return { rows, users: team(users) };
  },
  action: (s, ctx) => (s.denied ? null : { label: "Add", run: () => addSheet(ctx) }),
  render(s) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><h2>Not for this login</h2><p>Time off is kept by the office.</p></div></div>`;
    const now = Date.now();
    const rows = s.rows.filter((r) => !r.av);
    const coming = rows.filter((r) => !r.e || Date.parse(r.e) > now);
    const past = rows.filter((r) => r.e && Date.parse(r.e) <= now).reverse();
    const row = (r) => { const u = userById(s.users, r.uid); return html`<li class="wk-off"><div class="row"><span class="wk-dot" ${attrs({ style: `background:${(u && u.color) || "#4a4a52"}` })}></span><span class="who"><span class="nm">${u ? u.name : "Someone"}</span><span class="sub">${offWhen(r)}${r.r ? ` · ${r.r}` : ""}</span></span>
      <button type="button" class="icon-btn wk-x" ${attrs({ "data-del": r.id, "aria-label": "Remove" })}>${icon("plus")}</button></div></li>`; };
    return html`<div class="stack wk">
      ${coming.length ? html`<ul class="list">${coming.map(row)}</ul>` : emptyCard("Nobody is off", "Add vacations and appointments here; the schedule warns when a visit lands on them.", "sun")}
      ${past.length ? html`<div class="section-h">Last 30 days</div><ul class="list">${past.map(row)}</ul>` : ""}
    </div>`;
  },
  events: {
    "click [data-del]": async (e, el, ctx) => {
      if (!(await confirmSheet("Remove this time off?", { title: "Remove", yes: "Remove", danger: true }))) return;
      try { await ctx.api(`/time-off/${encodeURIComponent(el.dataset.del)}`, { method: "DELETE" }); toast("Removed"); } catch (err) { toast(err.message, { bad: true }); }
      ctx.refresh();
    },
  },
};
