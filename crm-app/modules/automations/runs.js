// Automations → one of yours → Run history: every start, newest first
// (who, when, where it is or why it stopped), and tap one for each step's
// outcome: done, sent to the sender (then what the sender did: in the
// Outbox as a dry run, sent, or skipped and why), "would have" for a record
// Rotor still owns, held while paused, waiting for a bulk send's test and
// confirm. automations:configure.

import { html, attrs, sheet, toast } from "../../core/ui.js";
import { dateTime } from "../../core/format.js";
import { ensureStyles, RUN_STATUS, STEP_STATUS, reasonText } from "./kit.js";

const label = (st) => ({ text: "Text", email: "Email", task: "Task", tag_add: "Add tag", tag_remove: "Remove tag", deal_stage: "Move the deal", assign_owner: "Assign owner", notify: "Tell the team", cadence: "Start a cadence", stop_if: "Stop if" })[st.type] || st.type;
const stepWhat = (st, names = {}) => [label(st), st.tag || st.title || (st.template_key && (names[st.template_key] || st.template_key)) || st.message || st.stage || st.cadence_key || ""].filter(Boolean).join(": ");
const resultText = (r) => (!r ? "" : r.startsWith("would-") ? "Would have (Rotor's record)" : r.startsWith("skipped:") ? `Skipped: ${r.slice(8).replace(/_/g, " ")}` : r.startsWith("stopped:") ? `Stopped: ${reasonText("stop_" + r.slice(8))}` : r === "queued" ? "Sent to the sender" : r === "done" ? "Done" : r.replace(/_/g, " "));
const sendText = (s) => (s.state === "done" ? (s.result === "dry_run" ? "In the Outbox (dry run)" : s.result === "sent" ? "Sent" : resultText(s.result || "")) : s.state === "claimed" ? "Waiting (quiet hours)" : s.state);

async function openRun(ctx, id) {
  let run;
  let names = {};
  try { const r = await ctx.api(`/automations/flows/${encodeURIComponent(ctx.params.id)}/runs/${encodeURIComponent(id)}`, { cache: false }); run = r.data.run; names = r.data.templates || {}; } catch (e) { toast(e.message, { bad: true }); return; }
  const st = RUN_STATUS[run.status] || [run.status, ""];
  sheet({
    title: run.contact_name || (run.members > 1 ? `${run.members} people` : "Run"),
    body: html`<div class="stack">
      <p class="small"><span ${attrs({ class: `pill ${st[1]}` })}>${st[0]}</span> Started ${dateTime(run.started_at)}${run.finished_at ? `, ended ${dateTime(run.finished_at)}` : run.next_at ? `, next ${dateTime(run.next_at)}` : ""}${run.stop_reason ? ` (${reasonText(run.stop_reason)})` : ""}${run.out ? `. ${run.out} left early.` : ""}</p>
      <ol class="au-out">${run.plan.map((p, i) => {
        const s = run.steps[i] || { status: "pending" };
        const send = (run.sends || []).find((x) => x.step === i);
        return html`<li><div class="t"><span>${i + 1}. ${stepWhat(p, names)}</span><span class="pill">${STEP_STATUS[s.status] || s.status}</span></div>
          ${s.at ? html`<p class="d">${dateTime(s.at)}${s.result ? ` · ${resultText(s.result)}` : ""}</p>` : s.due_at ? html`<p class="d">Due ${dateTime(s.due_at)}</p>` : ""}
          ${s.counts ? html`<p class="d">${Object.entries(s.counts).map(([k, n]) => `${n} ${k}`).join(", ")}</p>` : ""}
          ${send ? html`<p class="d">The sender: ${sendText(send)}</p>` : ""}
          ${s.bulk_run_id ? html`<p class="d"><a class="linkish" href="#/approvals">Open Approvals</a> to test and confirm it.</p>` : ""}</li>`;
      })}</ol>
    </div>`,
  });
}

export default {
  title: "Run history",
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api(`/automations/flows/${encodeURIComponent(params.id)}/runs`, { cache: false });
    return { runs: r.data.runs || [], next: r.data.next };
  },
  render(s) {
    if (!s.runs.length) return html`<div class="stack"><div class="card empty"><h2>No runs yet</h2><p>When it starts for someone, each run shows here with what every step did.</p></div></div>`;
    return html`<div class="stack"><ul class="list">${s.runs.map((r) => {
      const st = RUN_STATUS[r.status] || [r.status, ""];
      const done = r.steps.filter((x) => !["pending", "waiting", "held"].includes(x.status)).length;
      return html`<li><button type="button" class="row" ${attrs({ "data-run": r.id })}>
        <span class="who"><span class="nm">${r.contact_name || (r.members > 1 ? `${r.members} people` : "A customer")}</span>
        <span class="sub two">${dateTime(r.started_at)} · ${done} of ${r.plan.length} step${r.plan.length === 1 ? "" : "s"}${r.stop_reason ? ` · ${reasonText(r.stop_reason)}` : r.next_at ? ` · next ${dateTime(r.next_at)}` : ""}</span></span>
        <span class="end"><span ${attrs({ class: `pill ${st[1]}` })}>${st[0]}</span></span></button></li>`;
    })}</ul>${s.next ? html`<button type="button" class="btn block" data-more>Older runs</button>` : ""}</div>`;
  },
  events: {
    "click [data-run]": (e, el, ctx) => openRun(ctx, el.getAttribute("data-run")),
    "click [data-more]": async (e, el, ctx) => {
      try {
        const r = await ctx.api(`/automations/flows/${encodeURIComponent(ctx.params.id)}/runs?before=${encodeURIComponent(ctx.state.next)}`, { cache: false });
        ctx.state.runs = [...ctx.state.runs, ...(r.data.runs || [])]; ctx.state.next = r.data.next; ctx.rerender();
      } catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
