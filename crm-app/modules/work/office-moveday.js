// The rain-day move (design §9.2, §5.5 "move-day"): pick the day and the
// day it moves to, narrow by person or service, see exactly what moves
// (a preview: no writes), then Move. The server moves every visit in one
// run (a double tap is the same run), pushes each tech once, and makes the
// customers' notice as a bulk run that waits in Approvals for an owner's
// test and confirm. No reminder or confirmation goes out for a visit the
// move touched.

import { html, icon, attrs, toast } from "../../core/ui.js";
import { plural } from "../../core/format.js";
import { busy } from "../../core/forms.js";
import { ensureStyles, officeView, today, addDays, isDate, dayLabel, slotText, faces, names, loadUsers, team, SERVICE_TYPES } from "./office-kit.js";

const FINISHED = ["done", "failed", "cancelled"];

export default {
  title: "Rain day",
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    const q = new URLSearchParams((location.hash.split("?")[1]) || "");
    const from = isDate(q.get("date")) && q.get("date") >= today() ? q.get("date") : today();
    return { from, to: addDays(from, 1), users: team(await loadUsers(ctx).catch(() => [])), people: [], services: [], notify: true, preview: null, run: null, err: null };
  },
  render(s) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><h2>Not for this login</h2><p>Moving a day is for the office.</p></div></div>`;
    if (s.run) return done(s);
    const p = s.preview;
    return html`<form class="form stack wk" id="wk-move" novalidate>
      <div class="grid2">
        <label class="field" data-field="from_date"><span>Move the visits on</span><input type="date" name="from_date" ${attrs({ value: s.from })}></label>
        <label class="field" data-field="to_date"><span>To</span><input type="date" name="to_date" ${attrs({ value: s.to, min: today() })}></label>
      </div>
      <div class="field"><span>Only for (leave empty for everyone)</span><div class="wk-people">${s.users.map((u) => html`<button type="button" class="chip wk-person" ${attrs({ "data-person": u.id, "aria-pressed": String(s.people.includes(u.id)) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</button>`)}</div></div>
      <div class="field"><span>Only these services (leave empty for all)</span><div class="wk-people">${SERVICE_TYPES.map((t) => html`<button type="button" class="chip" ${attrs({ "data-svc": t, "aria-pressed": String(s.services.includes(t)) })}>${t}</button>`)}</div></div>
      <label class="check"><input type="checkbox" name="notify" ${attrs({ checked: s.notify })}><span>Tell the customers (a text each, after an owner sends a test and confirms)</span></label>
      ${s.err ? html`<div class="err">${s.err}</div>` : ""}
      ${p ? preview(s, p) : html`<button type="submit" class="btn primary block">See what moves</button>`}
    </form>`;
  },
  events: {
    "change [name=from_date]": (e, el, ctx) => { ctx.state.from = el.value; stale(ctx); },
    "change [name=to_date]": (e, el, ctx) => { ctx.state.to = el.value; stale(ctx); },
    "change [name=notify]": (e, el, ctx) => { ctx.state.notify = el.checked; stale(ctx); },
    "click [data-person]": (e, b, ctx) => { const s = ctx.state; const id = b.dataset.person; s.people = s.people.includes(id) ? s.people.filter((x) => x !== id) : [...s.people, id]; stale(ctx); },
    "click [data-svc]": (e, b, ctx) => { const s = ctx.state; const t = b.dataset.svc; s.services = s.services.includes(t) ? s.services.filter((x) => x !== t) : [...s.services, t]; stale(ctx); },
    "submit #wk-move": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const btn = form.querySelector("[type=submit]");
      busy(btn, true, s.preview ? "Moving…" : "Looking…");
      s.err = null;
      try {
        const body = { from_date: s.from, to_date: s.to, filter: { assignee_ids: s.people, service_types: s.services }, notify: s.notify };
        if (!s.preview) {
          s.preview = (await ctx.api("/schedule/move-day", { method: "POST", body })).data;
        } else {
          const r = await ctx.api("/schedule/move-day", { method: "POST", body: { ...body, confirm: true, token: s.preview.token } });
          s.run = r.data.run;
          ctx.rerender();
          follow(ctx, r.data.run_id);
          return;
        }
      } catch (err) {
        s.err = err.status === 409 ? "The day changed since you looked. Here it is again." : err.message || "That didn't work.";
        if (err.status === 409) s.preview = null;
      }
      ctx.rerender();
    },
  },
};

function stale(ctx) { ctx.state.preview = null; ctx.state.err = null; ctx.rerender(); }

function preview(s, p) {
  return html`<div class="stack">
    ${(p.warnings || []).map((w) => html`<div class="warn-box">${w.message}</div>`)}
    ${p.visits.length ? html`
      <div class="card"><h2>${plural(p.visits.length, "visit")} move from ${dayLabel(p.from_date)} to ${dayLabel(p.to_date)}</h2>
        <p>${plural(p.techs.length, "person", "people")} get one notice each.${p.notify ? ` ${plural(p.customers.length, "customer")} get a text once an owner confirms it.` : " Customers aren't told."}</p></div>
      <ul class="list">${p.visits.map((v) => html`<li><div class="row"><span class="who"><span class="nm">${v.contact_name || "Customer"}</span><span class="sub">${[v.town, v.job_number].filter(Boolean).join(" · ")}</span><span class="sub">${slotText({ start: v.start, end: v.end, window: v.window ? { type: v.window.t, minutes: v.window.m } : undefined })}</span></span><span class="end">${faces(s.users, v.assignee_ids)}</span></div></li>`)}</ul>
      <button type="submit" class="btn primary block">Move ${plural(p.visits.length, "visit")}</button>`
    : html`<div class="card empty"><div class="art">${icon("sun")}</div><h2>Nothing to move</h2><p>No booked visit on ${dayLabel(p.from_date)} matches.</p></div>`}
  </div>`;
}

function done(s) {
  const r = s.run;
  const res = r.result || {};          // the last step's answer: { bulk_run_id, moved, skipped }
  const fin = FINISHED.includes(r.status);
  return html`<div class="stack wk">
    <div class="card empty"><div class="art">${icon(r.status === "failed" ? "shield" : fin ? "check" : "sun")}</div>
      <h2>${r.status === "failed" ? "The move stopped" : fin ? "Moved" : "Moving…"}</h2>
      <p>${r.status === "failed" ? "Some visits may have moved. Open the day to check, then try again: it picks up where it stopped." : fin ? `${plural(res.moved || 0, "visit")} moved.${res.skipped ? ` ${plural(res.skipped, "visit")} had changed and stayed put.` : ""}${s.people.length ? ` For ${names(s.users, s.people)}.` : ""}` : "This takes a few seconds."}</p></div>
    ${fin && res.bulk_run_id ? html`<div class="note">The text to the customers waits in Approvals: send yourself a test, then confirm.</div><div class="btn-row"><a class="btn primary" href="#/approvals">${icon("check")}Open Approvals</a></div>` : ""}
    <div class="btn-row"><a class="btn" href="${`#/schedule?date=${s.to}`}">${icon("schedule")}Open ${dayLabel(s.to)}</a></div>
  </div>`;
}

async function follow(ctx, runId) {
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, i < 5 ? 800 : 1500));
    const r = await ctx.api(`/runs/${encodeURIComponent(runId)}`, { cache: false }).catch(() => null);
    if (!r || !ctx.state.run) continue;
    ctx.state.run = r.data;
    ctx.rerender();
    if (FINISHED.includes(r.data.status)) { if (r.data.status === "done") toast("Moved"); return; }
  }
}
