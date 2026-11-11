// Time (design §9.3 "Time"): this week's shifts (Sunday to Saturday) and
// visit timers, the hours per day and in all, a warning near 40 hours,
// entries waiting for the office, Clock in / Clock out (service, sales or
// office) and a note on a shift. Works with no signal from the last copy;
// clocking in or out waits in the phone's outbox like the rest.

import { html, icon, attrs, toast, sheet } from "../../core/ui.js";
import { dateShort, time as fmtTime, plural } from "../../core/format.js";
import { ensureStyles, TICONS, hm, since, send, waiting, onDrained, offlineLine, FULL_NOTE, dowOf, CATEGORY, STATUS, REASON } from "./tech-kit.js";

const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekQuery = () => { try { return new URLSearchParams(location.hash.split("?")[1] || "").get("week") || ""; } catch (e) { return ""; } };

async function load(params, ctx) {
  ensureStyles();
  const w = weekQuery();
  const r = await ctx.api(`/me/timesheets${w ? `?week=${encodeURIComponent(w)}` : ""}`);
  const all = await waiting();
  const items = all.filter((i) => i.path === "/clock");
  const data = r.data;
  let open = data.open;
  for (const it of all) {
    const b = it.body || {};
    if (it.path === "/clock" && b.action === "in" && !open) open = { start_at: b.client_at, category: b.category || "service", status: "open", local: true, client_id: b.client_id };
    else if (it.path === "/clock" && b.action === "out") open = null;
    // starting a timer clocks in (the shift takes the timer's client id)
    else if (/\/timer$/.test(it.path) && b.action === "start" && !open) open = { start_at: b.client_at, category: "service", status: "open", local: true, client_id: b.client_id };
  }
  onDrained(() => ctx.refresh());
  return { ...data, open, waiting: items.length, offline: !!r.offline, as_of: r.as_of || null, me: ctx.user || {} };
}

function shiftRow(s) {
  const day = dowOf(s.start_at);
  const flags = [s.auto_closed ? "Closed for you" : "", (s.edits || []).length ? "Edited by the office" : ""].filter(Boolean);
  const cls = { closed: "", approved: "green", open: "amber", pending_approval: "amber", locked: "green", rejected: "red", adjusted: "blue" }[s.status] || "";
  return html`<li class="tf-shift"><div class="row">
    <span class="who"><span class="nm">${day} ${fmtTime(s.start_at)}${s.end_at ? ` – ${fmtTime(s.end_at)}` : ""}</span>
    <span class="sub">${CATEGORY[s.category] || s.category}${flags.length ? ` · ${flags.join(" · ")}` : ""}${s.pending && s.pending.reason ? ` · ${REASON[s.pending.reason] || "needs a look"}` : ""}</span></span>
    <span class="end"><span class="num">${s.status === "open" ? html`<span ${attrs({ "data-since": s.start_at })}>${hm(since(s.start_at))}</span>` : hm(s.minutes)}</span><span class="${"pill " + cls}">${STATUS[s.status] || s.status}</span></span>
  </div>
  ${(s.notes || []).length ? html`<ul class="tf-notes">${s.notes.map((n) => html`<li>${n.text}</li>`)}</ul>` : ""}
  ${s.id && !String(s.id).startsWith("local") ? html`<div class="btn-row" style="margin:0 14px 12px"><button type="button" class="btn" ${attrs({ "data-note": s.id })}>${TICONS.note}Add a note</button></div>` : ""}
  </li>`;
}

export default {
  title: "Time",
  load,
  render(s) {
    const ws = s.week_start;
    const t = s.totals || {};
    const days = Object.entries(s.days || {});
    const max = Math.max(60, ...days.map(([, m]) => m));
    const thisWeek = !weekQuery();
    return html`<div class="stack">
      <div class="tf-weekbar"><a class="icon-btn" ${attrs({ href: `#/time?week=${addDays(ws, -7)}`, "aria-label": "Week before" })}>${icon("back")}</a><span class="d">${dateShort(ws)} – ${dateShort(s.week_end)}</span><a class="icon-btn" ${attrs({ href: `#/time?week=${addDays(ws, 7)}`, "aria-label": "Next week" })}><span class="flip">${icon("back")}</span></a></div>
      ${offlineLine({ offline: s.offline, as_of: s.as_of, waiting: s.waiting, what: "Your week" })}
      ${thisWeek ? (s.open
        ? html`<div class="card tf-clock on"><span class="who"><b>On the clock <span ${attrs({ "data-since": s.open.start_at })}>${hm(since(s.open.start_at))}</span></b><span>Since ${fmtTime(s.open.start_at)} · ${CATEGORY[s.open.category] || "Service"}</span></span><button type="button" class="btn dark" data-clock="out">Clock out</button></div>`
        : html`<div class="card tf-clock"><span class="who"><b>Not clocked in</b><span>Starting a visit's timer clocks you in too.</span></span><button type="button" class="btn primary" data-clock="in">${icon("time")}Clock in</button></div>`) : ""}
      <div class="card">
        <div class="tf-total"><b>${hm((t.minutes || 0) + (t.open_min || 0))}</b><span>${t.open_min ? "this week so far, counting now" : "this week"}${t.pending_min ? html`<br>${hm(t.pending_min)} waiting for the office` : ""}</span></div>
        ${t.over_ot ? html`<p class="warn-box" style="margin-top:10px">Over 40 hours: the rest of the week is overtime.</p>` : t.near_ot ? html`<p class="warn-box" style="margin-top:10px">Close to 40 hours this week.</p>` : ""}
        <div class="tf-bars" aria-hidden="true">${days.map(([d, m]) => html`<span class="${"tf-bar" + (m ? "" : " zero")}"><i ${attrs({ style: `height:${Math.round((m / max) * 70) + 3}px` })}></i><small>${dowOf(d)}</small></span>`)}</div>
      </div>
      ${(s.pending || []).length ? html`<div class="section-h">Waiting for the office</div><ul class="list">${s.pending.map(shiftRow)}</ul>` : ""}
      <div class="section-h">Shifts</div>
      ${(s.shifts || []).length ? html`<ul class="list">${s.shifts.filter((x) => x.status !== "pending_approval").map(shiftRow)}</ul>` : html`<div class="card empty"><div class="art">${icon("time")}</div><h2>No shifts this week</h2><p>Clock in when you start, or start a visit's timer.</p></div>`}
      ${(s.timers || []).length ? html`<div class="section-h">Visit timers</div><ul class="list">${s.timers.map((x) => html`<li><div class="row"><span class="who"><span class="nm">${x.visit ? x.visit.job_title || "A visit" : "No visit"}${x.visit && x.visit.town ? ` · ${x.visit.town}` : ""}</span>
        <span class="sub">${dowOf(x.timer.start_at)} ${fmtTime(x.timer.start_at)}${x.timer.end_at ? ` – ${fmtTime(x.timer.end_at)}` : " · running"}${x.timer.auto_closed ? " · stopped for you" : ""}</span></span>
        <span class="end num">${x.timer.end_at ? hm(x.timer.minutes) : html`<span ${attrs({ "data-since": x.timer.start_at })}>${hm(since(x.timer.start_at))}</span>`}</span></div></li>`)}</ul>` : ""}
      <p class="foot-note">${plural((s.shifts || []).length, "shift")} this week. Times are Delano time.</p>
    </div>`;
  },
  mount(view) {
    const timer = setInterval(() => {
      if (!document.contains(view) || !view.querySelector("[data-since]")) { clearInterval(timer); return; }
      for (const x of view.querySelectorAll("[data-since]")) x.textContent = hm(since(x.dataset.since));
    }, 30000);
  },
  events: {
    "click [data-clock]": async (e, el, ctx) => {
      const action = el.dataset.clock;
      let category = "service";
      if (action === "in") {
        category = await new Promise((resolve) => {
          let picked = null;
          const sh = sheet({
            title: "Clock in for",
            body: html`<ul class="tf-pick">${Object.entries(CATEGORY).map(([k, l]) => html`<li><button type="button" ${attrs({ "data-cat": k })}>${l}<small>${k === "service" ? "Visits and field work" : k === "sales" ? "Estimates and sales calls" : "Office work"}</small></button></li>`)}</ul>`,
            onClose: () => resolve(picked),
            events: { "click [data-cat]": (ev, b) => { picked = b.dataset.cat; sh.close(); } },
          });
        });
        if (!category) return;
      }
      el.disabled = true;
      try {
        // a clock-out names the shift this phone knows is open (two phones: never the other one's)
        const shift = action === "out" && ctx.state.open && ctx.state.open.client_id ? { shift_client_id: ctx.state.open.client_id } : {};
        const r = await send(ctx, "/clock", { action, ...(action === "in" ? { category } : shift) });
        toast(r.queued ? (r.saved === false ? FULL_NOTE : "Saved on this phone. It goes out when you have signal.") : r.data && r.data.pending ? r.data.message : action === "in" ? "Clocked in" : "Clocked out", r.saved === false || (r.data && r.data.pending) ? { bad: true, ms: 6000 } : undefined);
      } catch (err) { toast((err && err.message) || "That didn't work.", { bad: true }); }
      ctx.refresh();
    },
    "click [data-note]": (e, el, ctx) => {
      const id = el.dataset.note;
      const sh = sheet({
        title: "A note on this shift",
        body: html`<form class="stack" data-shift-note><label class="field"><span>Note</span><textarea name="text" rows="3" maxlength="500" placeholder="Lunch 12:00-12:30, picked up supplies"></textarea></label><button type="submit" class="btn primary block">Save</button></form>`,
        events: {
          "submit [data-shift-note]": async (ev, f) => {
            ev.preventDefault();
            const text = String(f.elements.text.value || "").trim();
            if (!text) { toast("Write the note first.", { bad: true }); return; }
            sh.close();
            try {
              const r = await send(ctx, `/me/timesheets/${encodeURIComponent(id)}/notes`, { text });
              toast(r.queued ? (r.saved === false ? FULL_NOTE : "Saved on this phone. It goes out when you have signal.") : "Note saved", r.saved === false ? { bad: true, ms: 6000 } : undefined);
            } catch (err) { toast((err && err.message) || "That didn't save.", { bad: true }); }
            ctx.refresh();
          },
        },
      });
    },
  },
};
