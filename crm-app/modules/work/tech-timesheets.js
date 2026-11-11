// Timesheets, the office's (design §9.2 "Timesheets", §5.5, §2.5): the week
// (Sunday to Saturday) per person, each shift with its flags (closed for
// them, edited, open, waiting), the week's hours and overtime, Approve the
// week; and the entries waiting for a decision from any recent week: a
// time a phone sent that the server didn't take on its own, or an offline
// change that no longer fit its visit. Approve as claimed, edit the times
// (with a reason), or don't count it. An edit always says why, and the
// tech sees it on their Time screen.

import { html, icon, attrs, toast, sheet, confirmSheet } from "../../core/ui.js";
import { dateShort, time as fmtTime, plural, localDate } from "../../core/format.js";
import { ensureStyles, TICONS, hm, dowOf, hhmmOf, isoFromLocal, CATEGORY, REASON } from "./tech-kit.js";

const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekQuery = () => { try { return new URLSearchParams(location.hash.split("?")[1] || "").get("week") || ""; } catch (e) { return ""; } };
const ROW_ST = { open: ["amber", "On the clock"], closed: ["", "To approve"], approved: ["green", "Approved"], locked: ["green", "Paid period"], pending_approval: ["amber", "Waiting"], rejected: ["red", "Not counted"], adjusted: ["blue", "Adjustment"] };
const nameOf = (people, id) => ((people || []).find((p) => p.id === id) || {}).name || "Someone";

function entryRow(r) {
  const [cls, label] = ROW_ST[r.st] || ["", r.st];
  const flags = [r.ac ? "Closed for them" : "", r.ed ? "Edited" : "", (r.fl || []).includes("timer_auto_closed") ? "A timer was stopped" : ""].filter(Boolean);
  return html`<li><span class="d">${dowOf(r.s)}</span><span class="t">${fmtTime(r.s)}${r.e ? ` – ${fmtTime(r.e)}` : ""}${r.cat && r.cat !== "service" ? ` · ${CATEGORY[r.cat] || r.cat}` : ""}<small><span class="${"pill " + cls}">${label}</span>${flags.length ? ` ${flags.join(" · ")}` : ""}</small></span>
    <span class="m">${r.min !== null && r.min !== undefined ? hm(r.min) : ""}</span>
    ${["open", "closed", "approved", "pending_approval"].includes(r.st) ? html`<button type="button" class="icon-btn" ${attrs({ "data-edit": r.id, "aria-label": "Edit this entry" })}>${TICONS.edit}</button>` : ""}</li>`;
}

export default {
  title: "Timesheets",
  async load(params, ctx) {
    ensureStyles();
    const w = weekQuery();
    const r = await ctx.api(`/timesheets${w ? `?week=${encodeURIComponent(w)}` : ""}`, { cache: false });
    return r.data;
  },
  render(s) {
    const ws = s.week_start;
    const people = s.people || [];
    return html`<div class="stack">
      <div class="tf-weekbar"><a class="icon-btn" ${attrs({ href: `#/timesheets?week=${addDays(ws, -7)}`, "aria-label": "Week before" })}>${icon("back")}</a><span class="d">${dateShort(ws)} – ${dateShort(s.week_end)}</span><a class="icon-btn" ${attrs({ href: `#/timesheets?week=${addDays(ws, 7)}`, "aria-label": "Next week" })}><span class="flip">${icon("back")}</span></a></div>
      ${(s.pending || []).length ? html`<div class="section-h">Waiting for a decision</div><ul class="list tf-pend">${s.pending.map((r) => html`<li><div class="row">
        <span class="who"><span class="nm">${nameOf(people, r.uid)}</span><span class="sub">${dateShort(localDate(r.s))} ${fmtTime(r.s)}${r.e && r.e !== r.s ? ` – ${fmtTime(r.e)}` : ""}${r.min ? ` · ${hm(r.min)}` : ""}</span><span class="sub">${REASON[r.why] ? `Why: ${REASON[r.why]}` : "Needs a look"}</span></span>
        <span class="end"><button type="button" class="btn" ${attrs({ "data-decide": r.id })}>Decide</button></span></div></li>`)}</ul>` : ""}
      ${(s.weeks || []).map((w) => {
        const p = people.find((x) => x.id === w.user_id) || { name: "Someone" };
        return html`<div class="card"><div class="tf-person"><span class="wk-dot big" ${attrs({ style: `background:${p.color || "#85858d"}` })}></span><h2>${p.name}</h2><span class="num">${hm(w.minutes)}</span></div>
          ${w.entries.length ? html`<p class="small muted">${w.ot_min ? `${hm(w.ot_min)} overtime · ` : ""}${w.approved ? `${plural(w.approved, "shift")} approved` : "Nothing approved yet"}${w.open ? " · on the clock now" : ""}${w.pending ? ` · ${w.pending} waiting` : ""}</p>
            <ul class="tf-entries">${w.entries.map(entryRow)}</ul>` : html`<p class="small muted">No time this week.</p>`}
          ${w.to_approve ? html`<div class="btn-row"><button type="button" class="btn primary" ${attrs({ "data-approve": w.user_id })}>${icon("check")}Approve the week (${w.to_approve})</button></div>` : ""}</div>`;
      })}
      ${(s.weeks || []).length ? "" : html`<div class="card empty"><div class="art">${icon("clock")}</div><h2>No time this week</h2><p>Shifts show here as people clock in and start their visits' timers.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-approve]": async (e, el, ctx) => {
      const uid = el.dataset.approve;
      // shifts the app closed for them (a forgotten clock-out) are pointed out first
      const week = (ctx.state.weeks || []).find((w) => w.user_id === uid);
      const auto = ((week && week.entries) || []).filter((r) => r.st === "closed" && (r.ac || (r.fl || []).includes("timer_auto_closed")));
      const autoNote = auto.length ? ` ${auto.length === 1 ? "One shift was" : `${auto.length} shifts were`} closed by the app, not by them: ${auto.map((r) => `${dowOf(r.s)} ${fmtTime(r.s)} – ${r.e ? fmtTime(r.e) : "?"}`).join("; ")}. Check ${auto.length === 1 ? "it" : "them"} first (tap the pencil to fix).` : "";
      if (!(await confirmSheet(`Approve ${nameOf(ctx.state.people, uid)}'s finished shifts for this week? Open and waiting ones stay as they are.${autoNote}`, { title: auto.length ? "Approve, with shifts closed for them?" : "Approve the week", yes: auto.length ? "Approve anyway" : "Approve" }))) return;
      try {
        let r;
        let n = 0;
        for (let i = 0; i < 5; i++) {
          r = await ctx.api("/timesheets/approve", { method: "POST", body: { user_id: uid, week_start: ctx.state.week_start } });
          n += r.data.approved;
          if (!r.data.more) break;
        }
        toast(`${plural(n, "shift")} approved${r.data.pending ? `; ${r.data.pending} still waiting` : ""}`);
      } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
      ctx.refresh();
    },
    "click [data-edit]": (e, el, ctx) => editSheet(ctx, el.dataset.edit, { decide: false }),
    "click [data-decide]": (e, el, ctx) => editSheet(ctx, el.dataset.decide, { decide: true }),
  },
};

// What the phone said, kept on the entry (a note's text, a checklist value, a line).
function said(pend) {
  const p = pend.payload;
  if (!p) return "";
  const bits = [p.text, p.note, p.key ? `${p.key}${p.value !== undefined ? `: ${p.value}` : ""}` : "", p.price_item_id ? `${p.qty || 1} × ${p.price_item_id}` : ""].filter(Boolean);
  return bits.length ? html`<p class="tf-said">${bits.join("\n")}</p>` : "";
}

async function editSheet(ctx, id, { decide }) {
  let got;
  try { got = await ctx.api(`/timesheets/${encodeURIComponent(id)}`, { cache: false }); } catch (err) { toast(err.message || "That entry didn't load.", { bad: true }); return; }
  const t = got.data.sheet;
  const date = localDate(t.start_at);
  const pend = t.pending || {};
  const who = nameOf(ctx.state.people, t.user_id);
  // an entry that only reports an offline change (it spans no time): the office reads it and marks it seen
  const notice = decide && !!pend.action && t.end_at === t.start_at;
  const s = sheet({
    title: notice ? "Offline work to check" : decide ? "Decide on this entry" : "Edit this entry",
    body: html`<form class="stack" id="tf-edit">
      <p class="small muted">${who} · ${dateShort(date)}${pend.reason ? ` · ${REASON[pend.reason] || "needs a look"}` : ""}${pend.detail ? `: ${pend.detail}` : ""}</p>
      ${pend.action ? html`<p class="small">${`Their phone sent "${String(pend.action).replace(/_/g, " ")}"${pend.job_title ? ` on ${pend.job_title}` : ""} at ${fmtTime(pend.claimed || t.start_at)}${pend.applied ? "; it went in" : ""}.`}</p>` : ""}
      ${said(pend)}
      ${(pend.file_ids || []).length ? html`<div class="tf-held">${pend.file_ids.map((fid) => html`<a ${attrs({ href: `/api/crm/files/${encodeURIComponent(fid)}`, target: "_blank", rel: "noopener" })}><img ${attrs({ src: `/api/crm/files/${encodeURIComponent(fid)}?thumb=1`, alt: "The photo they sent", loading: "lazy" })}></a>`)}</div>` : ""}
      ${pend.timer ? html`<p class="small">Their timer: ${fmtTime(pend.timer.start)}${pend.timer.end ? ` – ${fmtTime(pend.timer.end)}` : ", no stop yet"}.</p>` : ""}
      ${notice ? html`<p class="small muted">Nothing here counts as time. Fix the visit or the job if it needs it, then mark this seen.</p>
        <input type="hidden" name="date" ${attrs({ value: date })}><input type="hidden" name="start" ${attrs({ value: hhmmOf(t.start_at) })}><input type="hidden" name="end" ${attrs({ value: hhmmOf(t.end_at) })}><input type="hidden" name="category" ${attrs({ value: t.category })}>
        <div class="btn-row"><button type="submit" class="btn primary">${icon("check")}Seen it</button></div></form>` : html`
      <label class="field"><span>Day</span><input name="date" type="date" ${attrs({ value: date })} required></label>
      <div class="tf-small">
        <label class="field" style="flex:1 1 40%"><span>Start</span><input name="start" type="time" ${attrs({ value: hhmmOf(t.start_at) })} required></label>
        <label class="field" style="flex:1 1 40%"><span>End</span><input name="end" type="time" ${attrs({ value: t.end_at ? hhmmOf(t.end_at) : "" })}></label>
      </div>
      <label class="field"><span>Category</span><select name="category">${Object.entries(CATEGORY).map(([k, l]) => html`<option ${attrs({ value: k, selected: k === t.category })}>${l}</option>`)}</select></label>
      <label class="field"><span>Why it changed</span><input name="reason" type="text" maxlength="300" placeholder="Forgot to clock out at 4:30" autocomplete="off"></label>
      <div class="btn-row">
        ${decide ? html`<button type="button" class="btn danger" data-reject>Don't count it</button><button type="submit" class="btn primary">Approve</button>` : html`<button type="submit" class="btn primary">Save</button>`}
      </div></form>`}`,
    events: {
      "submit #tf-edit": async (ev, f) => {
        ev.preventDefault();
        const fd = Object.fromEntries(new FormData(f).entries());
        const start = isoFromLocal(fd.date, fd.start);
        let end = fd.end ? isoFromLocal(fd.date, fd.end) : null;
        if (end && Date.parse(end) <= Date.parse(start)) end = isoFromLocal(addDays(fd.date, 1), fd.end);
        const body = {};
        // only what was changed (the form shows minutes; the entry keeps seconds)
        if (fd.date !== date || fd.start !== hhmmOf(t.start_at)) body.start_at = start;
        if (end && (!t.end_at || fd.end !== hhmmOf(t.end_at) || fd.date !== date)) body.end_at = end;
        if (fd.category !== t.category) body.category = fd.category;
        const reason = String(fd.reason || "").trim();
        if (Object.keys(body).length && !reason) { toast("Say why it changed.", { bad: true }); return; }
        try {
          if (decide) await ctx.api(`/timesheets/${encodeURIComponent(id)}/decide`, { method: "POST", body: { decision: "approve", ...body, reason } });
          else {
            if (!Object.keys(body).length) { s.close(); return; }
            await ctx.api(`/timesheets/${encodeURIComponent(id)}`, { method: "PATCH", body: { ...body, reason }, ifMatch: got.etag });
          }
          toast(notice ? "Marked seen" : decide ? "Approved" : "Saved");
          s.close();
          ctx.refresh();
        } catch (err) {
          toast(err.status === 412 ? "Someone else just changed this entry. Here it is again." : err.message || "That didn't save.", { bad: true });
          if (err.status === 412) { s.close(); ctx.refresh(); }
        }
      },
      "click [data-reject]": async () => {
        try {
          await ctx.api(`/timesheets/${encodeURIComponent(id)}/decide`, { method: "POST", body: { decision: "reject" } });
          toast("Not counted");
          s.close();
          ctx.refresh();
        } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
      },
    },
  });
}
