// One campaign (design §9.2 "Campaign builder", §5.7.5, B4): who it goes to
// (filters with a live count and who is left out, by reason), the template
// with sample texts, the required test send, then Send now or a schedule;
// afterwards the results per person. A campaign from Rotor is history: it
// shows what Rotor kept and can't be sent.
// A text blast (Flyra's SMS Blast, the Rotor guide's K13 to K15): your own
// words with a live count of characters and texts, the cost per person and
// in all (Settings → Business numbers' price), + a variable, a picture
// (kept until picture texts are set up), the people from the filters or a
// CSV with a consent column, "Start from a past winner", and a follow-up to
// the people who didn't reply (its own bulk send, tested and confirmed like
// this one). /campaigns/new?kind=blast makes one.

import { html, attrs, icon, toast, confirmSheet, sheet, tileRow, pillBtn, render as paintInto, toggle as switchOf } from "../../core/ui.js";
import { dateTime, money } from "../../core/format.js";
import { capture, uploadPhoto } from "../../core/camera.js";
import { ensureStyles, reasonText } from "./kit.js";
import { pill, statTiles } from "./campaigns.js";

const LIFE = [["lead", "Leads"], ["customer", "Customers"], ["former_customer", "Former customers"]];
const WHY = { archived: "archived", excluded_flag: "test, vendor or spam contacts", no_address: "no number or email", duplicate: "a second contact on the same number", opted_out: "opted out", recent_campaign: "got a campaign in the last 3 days", excluded_by_hand: "left out by hand", no_consent: "no consent for marketing texts", no_contact: "contact gone" };
const UNSUP = { services_done: "Services done", last_service_between: "Last service date", has_lights_season: "Lights season", tiers: "Service area tier", created_between: "Created between", "plan_status:cancelled": "Cancelled plans" };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Texts a message takes (GSM: 160, then 153 each; anything else: 70, then 67), with the opt-out line the sender adds.
export function segmentsOf(text) {
  const t = String(text || "") + " Reply STOP to opt out.";
  const gsm = /^[\n\r\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(t);
  const n = Array.from(t).length;
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return { chars: n, segments: n <= one ? 1 : Math.ceil(n / many), left: n <= one ? one - n : many - (n % many || many) };
}
const cents = (c) => (c < 100 ? `${Math.round(c * 10) / 10}¢` : money(Math.round(c)));
const VARS = [["first_name", "First name"], ["town", "Town"], ["company_name", "Company"]];

async function load(params, ctx) {
  ensureStyles();
  // New text blast: make it, then open it by its own address
  if (params.id === "new") {
    const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
    const made = await ctx.api("/campaigns", { method: "POST", body: { name: q.get("kind") === "blast" ? `Text blast ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "New campaign", ...(q.get("kind") === "blast" ? { kind: "blast" } : {}), channel: "sms" } });
    ctx.go("/campaigns/" + encodeURIComponent(made.data.id), { replace: true });
    return { c: made.data, etag: made.etag, preview: null, templates: [], recipients: null, busy: "", stats: null };
  }
  const r = await ctx.api(`/campaigns/${encodeURIComponent(params.id)}`, { cache: false });
  const c = r.data;
  const s = { c, etag: r.etag, preview: null, templates: [], recipients: null, busy: "" };
  if (!c.imported && ["draft", "tested", "scheduled"].includes(c.status)) {
    const [t, p] = await Promise.all([ctx.api(`/templates?channel=${c.channel}`, { cache: false }), ctx.api(`/campaigns/${c.id}/preview`, { method: "POST", body: {} }).catch(() => null)]);
    s.templates = (t.data || []).filter((x) => x.active !== false && x.category !== "staff");
    s.preview = p ? p.data : null;
    // (the preview is kept on the campaign: read its new version so the next save matches)
    if (p) { const again = await ctx.api(`/campaigns/${c.id}`, { cache: false }); s.c = again.data; s.etag = again.etag; }
  } else if (!c.imported && c.run) {
    const [rc, st] = await Promise.all([ctx.api(`/campaigns/${c.id}/recipients`, { cache: false }).catch(() => ({ data: [] })), ctx.api(`/campaigns/${c.id}/stats`, { cache: false }).catch(() => null)]);
    s.recipients = rc.data;
    s.stats = st ? st.data : null;
  }
  return s;
}

const chipSet = (name, choices, picked) => html`<div class="cm-toggle">${choices.slice(0, 24).map((x) => html`<button type="button" class="chip" ${attrs({ "data-pick": name, "data-value": x.value, "aria-pressed": String((picked || []).includes(x.value)) })}>${x.label || x.value}${x.n ? html` <span class="n">${x.n}</span>` : ""}</button>`)}</div>`;

const samples = (p) => (p && (p.samples || []).length ? html`<div class="section-h">How it reads</div>${p.samples.slice(0, 3).map((x) => html`<div><p class="small muted">${x.name}</p><div class="preview">${x.subject ? html`<b>${x.subject}</b>\n` : ""}${x.text}</div>${(x.missing || []).length ? html`<p class="small" style="color:var(--coral-ink)">Missing for them: ${x.missing.join(", ").replace(/_/g, " ")} (they would be skipped)</p>` : ""}</div>`)}` : "");

function costLine(s, body) {
  const p = s.preview;
  const seg = segmentsOf(body);
  const per = p && p.cost ? (p.cost.per_person_cents / Math.max(1, p.cost.segments)) * seg.segments : null;
  const pic = (s.c.media_file_ids || []).length > 0;
  return html`<p class="small muted cm-cost" data-cost>${seg.chars} characters · ${seg.segments} text${seg.segments === 1 ? "" : "s"} each${seg.segments === 1 ? ` (${seg.left} left at this price)` : ""}${per !== null && !pic ? ` · about ${cents(per)} a person, ${cents(per * (p.count || 0))} for ${p.count}` : ""}${pic && p && p.cost ? ` · a picture text, about ${cents(p.cost.per_person_cents)} a person` : ""}</p>`;
}

function blastWords(s) {
  const c = s.c;
  const locked = c.status === "scheduled";
  const fu = c.followup || { on: false, after_hours: 48, body: "" };
  return html`<section class="card stack"><h2>What it says</h2>
      <label class="field"><span>Your text</span><textarea name="body" data-body rows="5" maxlength="1600" ${attrs({ disabled: locked ? true : null, placeholder: "Hi {{first_name|there}}, spring window cleanings are open..." })}>${c.body || ""}</textarea>
        <small>The opt-out line is added for you. Only people who agreed to marketing texts get it.</small></label>
      <div data-cost-box>${costLine(s, c.body)}</div>
      <div class="cm-toggle">${VARS.map(([k, l]) => html`<button type="button" class="chip" ${attrs({ "data-var": k, disabled: locked ? true : null })}>+ ${l}</button>`)}</div>
      <div class="rs-pills">${pillBtn((c.media_file_ids || []).length ? "Picture added" : "Add picture", { icon: "camera", data: { "blast-pic": true }, disabled: locked })}${pillBtn("Start from a past winner", { icon: "trophy", data: { "blast-win": true }, disabled: locked })}</div>
      ${(c.media_file_ids || []).length ? html`<p class="small muted">The picture goes with the texts once picture texts are set up; until then the blast is a dry run in the Outbox.</p>` : ""}
      ${samples(s.preview)}
    </section>
    <section class="card stack"><h2>Follow up</h2>
      <div class="rs-frow"><span class="rs-fl">Text the people who didn't reply<small>Its own send: you test and confirm it like this one</small></span>${switchOf(!!fu.on, { data: { "fu-on": true }, label: "Follow up with who didn't reply", disabled: locked })}</div>
      ${fu.on ? html`<label class="field"><span>After</span><select data-fu-after ${attrs({ disabled: locked ? true : null })}>${[[24, "1 day"], [48, "2 days"], [72, "3 days"], [168, "1 week"]].map(([h, l]) => html`<option ${attrs({ value: String(h), selected: fu.after_hours === h })}>${l}</option>`)}</select></label>
        <label class="field"><span>Follow-up text</span><textarea data-fu-body rows="3" maxlength="1600" ${attrs({ disabled: locked ? true : null })}>${fu.body || ""}</textarea></label>` : ""}
    </section>`;
}

function builder(s) {
  const c = s.c;
  const a = c.audience || {};
  const p = s.preview;
  const ch = (p && p.choices) || {};
  const locked = c.status === "scheduled";
  return html`
    <section class="card stack"><h2>Who gets it</h2>
      <div class="field"><span>People</span>${chipSet("lifecycle", LIFE.map(([value, label]) => ({ value, label })), a.lifecycle)}</div>
      ${c.channel === "sms" ? html`<div class="rs-pills">${pillBtn("Upload a CSV", { icon: "doc", data: { csv: true }, disabled: locked })}</div>
        ${c.csv ? html`<p class="small muted">From the CSV: ${c.csv.used} of ${c.csv.rows} people${c.csv.no_consent ? `, ${c.csv.no_consent} left out with no consent` : ""}${c.csv.unknown ? `, ${c.csv.unknown} not in the CRM` : ""}.</p>` : html`<p class="small muted">A CSV needs a phone or email column and a consent column (yes or no).</p>`}` : ""}
      ${(ch.towns || []).length ? html`<div class="field"><span>Towns</span>${chipSet("towns", ch.towns, a.towns)}</div>` : ""}
      ${(ch.tags || []).length ? html`<div class="field"><span>Tagged</span>${chipSet("tags_any", ch.tags, a.tags_any)}</div>` : ""}
      ${(ch.sources || []).length ? html`<div class="field"><span>Came from</span>${chipSet("sources", ch.sources, a.sources)}</div>` : ""}
      ${(ch.services_quoted || []).length ? html`<div class="field"><span>Were quoted</span>${chipSet("services_quoted", ch.services_quoted, a.services_quoted)}</div>` : ""}
      <div class="field"><span>More</span><div class="cm-toggle">
        <button type="button" class="chip" ${attrs({ "data-flag": "no_review", "aria-pressed": String(a.no_review === true) })}>No Google review yet</button>
        <button type="button" class="chip" ${attrs({ "data-flag": "has_open_quote", "aria-pressed": String(a.has_open_quote === true) })}>Has an open quote</button>
        <button type="button" class="chip" ${attrs({ "data-plan": "active", "aria-pressed": String((a.plan_status || []).includes("active")) })}>On a plan</button>
        <button type="button" class="chip" ${attrs({ "data-plan": "none", "aria-pressed": String((a.plan_status || []).includes("none")) })}>Not on a plan</button>
      </div></div>
      ${p ? html`<div class="cm-stat"><div><b>${p.count}</b><span>would get it</span></div><div><b>${p.matched - p.count}</b><span>left out</span></div><div><b>${p.matched}</b><span>match</span></div></div>
        ${Object.keys(p.excluded || {}).length ? html`<p class="small muted">Left out: ${Object.entries(p.excluded).map(([k, n]) => `${n} ${WHY[k] || k.replace(/_/g, " ")}`).join(" · ")}</p>` : ""}
        ${(p.unsupported || []).length ? html`<div class="warn-box">${p.unsupported.map((u) => UNSUP[u] || u).join(", ")}: this filter needs data that isn't in the CRM yet, so it matches nobody.</div>` : ""}
        ${p.over_limit ? html`<div class="warn-box">One campaign reaches at most 2,000 people. Narrow the audience.</div>` : ""}
        ${p.consent_note ? html`<p class="small muted">${p.consent_note}</p>` : ""}` : ""}
    </section>
    ${c.kind === "blast" ? blastWords(s) : html`<section class="card stack"><h2>What it says</h2>
      <label class="field"><span>Template</span><select name="template_key" data-template ${attrs({ disabled: locked ? true : null })}>
        <option value="">Pick a template</option>${s.templates.map((t) => html`<option value="${t.key}" ${attrs({ selected: t.key === c.template_key ? true : null })}>${t.name} (${t.category})</option>`)}</select>
        <small>Write or edit templates under Menu → Templates. The opt-out line is added for you.</small></label>
      ${samples(p)}
    </section>`}
    <section class="card stack"><h2>Test, then send</h2>
      ${c.status === "draft" ? html`<p class="small">A test goes to your test contact first. Nothing can be sent before it.</p>
        <button type="button" class="btn primary block" data-test ${attrs({ disabled: !c.template_key || !p || !p.count || p.over_limit || s.busy ? true : null })}>${s.busy === "test" ? "Preparing the test…" : "Send the test"}</button>` : ""}
      ${c.status === "tested" ? html`<div class="ok-box">Test sent ${c.test && c.test.sent_at ? dateTime(c.test.sent_at) : ""}${c.test && c.test.mode === "dry_run" ? " (dry run: it is in the Outbox)" : ""}.</div>
        ${p && p.count !== undefined && c.audience_preview && c.audience_preview.prepared ? html`<p class="small">${c.audience_preview.prepared.count} people will get it${Object.keys(c.audience_preview.prepared.excluded || {}).length ? ` (left out: ${Object.entries(c.audience_preview.prepared.excluded).map(([k, n]) => `${n} ${WHY[k] || k.replace(/_/g, " ")}`).join(" · ")})` : ""}.</p>` : ""}
        <button type="button" class="btn primary block" data-now ${attrs({ disabled: s.busy ? true : null })}>Send now</button>
        <label class="field"><span>Or pick a time</span><input type="datetime-local" name="send_at" data-when></label>
        <div class="btn-row"><button type="button" class="btn" data-schedule>Schedule it</button><button type="button" class="btn" data-test>Test again</button></div>` : ""}
      ${c.status === "scheduled" ? html`<div class="ok-box">Scheduled for ${dateTime(c.send_at)}.</div><div class="btn-row"><button type="button" class="btn" data-unschedule>Take it off the schedule</button></div>` : ""}
      <button type="button" class="btn danger block" data-cancel>Cancel this campaign</button>
    </section>`;
}

function results(s) {
  const c = s.c;
  const st = c.stats || {};
  const skipped = Object.values(st.skipped || {}).reduce((x, y) => x + y, 0);
  return html`${s.stats ? tileRow(statTiles(s.stats), { name: "cs", label: "This campaign" }) : ""}<section class="card stack"><h2>Results</h2>
    <div class="cm-stat"><div><b>${(st.sent || 0) + (st.dry_run || 0)}</b><span>${st.dry_run ? "to the Outbox (dry run)" : "sent"}</span></div><div><b>${skipped}</b><span>skipped</span></div><div><b>${st.failed || 0}</b><span>failed</span></div></div>
    ${Object.keys(st.skipped || {}).length ? html`<p class="small muted">Skipped: ${Object.entries(st.skipped).map(([k, n]) => `${n} ${WHY[k] || reasonText(k)}`).join(" · ")}</p>` : ""}
    ${c.status === "sending" ? html`<p class="small">Still going out, 25 at a time. <button type="button" class="linkish" data-refresh>Refresh</button></p><button type="button" class="btn danger block" data-cancel>Stop it</button>` : ""}
    ${(s.recipients || []).length ? html`<ul class="list">${s.recipients.slice(0, 200).map((x) => html`<li><a class="row" href="${"#/contacts/" + encodeURIComponent(x.contact_id)}"><span class="who"><span class="nm">${x.name || "A contact"}</span><span class="sub">${x.status === "dry_run" ? "Not sent (dry run)" : x.status === "waiting" ? "Waiting" : x.status}${x.reason ? `: ${WHY[x.reason] || reasonText(x.reason)}` : ""}</span></span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>` : ""}
  </section>`;
}

function render(s) {
  const c = s.c;
  return html`<div class="stack">
    <section class="card stack">
      <div class="stack-head"><h2>${c.name}</h2>${pill(c.status)}</div>
      ${c.imported ? html`<p class="small muted">Sent from Rotor${c.rotor && c.rotor.number ? ` from ${c.rotor.number}` : ""}${c.created_at ? `, ${dateTime(c.created_at)}` : ""}. Rotor doesn't export who got it; the messages are in each customer's thread.</p>
        ${c.description ? html`<div class="preview">${c.description}</div>` : ""}${c.template_key ? html`<p class="small">Template: <a href="#/templates">${c.template_key}</a></p>` : ""}`
        : ["draft", "tested", "scheduled"].includes(c.status) ? html`<label class="field"><span>Notes (who and why)</span><textarea name="description" data-notes rows="2" maxlength="2000">${c.description || ""}</textarea></label>` : c.description ? html`<p class="small">${c.description}</p>` : ""}
    </section>
    ${c.imported ? "" : ["draft", "tested", "scheduled"].includes(c.status) ? builder(s) : results(s)}
  </div>`;
}

async function save(ctx, patch) {
  const s = ctx.state;
  try {
    const r = await ctx.api(`/campaigns/${s.c.id}`, { method: "PATCH", body: patch, ifMatch: s.etag });
    s.c = r.data; s.etag = r.etag;
    s.preview = (await ctx.api(`/campaigns/${s.c.id}/preview`, { method: "POST", body: {} })).data;
    s.etag = (await ctx.api(`/campaigns/${s.c.id}`, { cache: false })).etag;
  } catch (e) {
    toast((e && e.message) || "That didn't save.", { bad: true });
    if (e && e.status === 412) ctx.refresh();
  }
  ctx.rerender();
}
const toggle = (list, v) => ((list || []).includes(v) ? (list || []).filter((x) => x !== v) : [...(list || []), v]);
async function act(ctx, path, body, done) {
  const s = ctx.state;
  try {
    const r = await ctx.api(`/campaigns/${s.c.id}/${path}`, { method: "POST", body });
    if (done) toast(done);
    return r;
  } catch (e) { toast((e && e.message) || "That didn't work.", { bad: true }); return null; }
}

export default {
  load, render,
  title: (s) => (s && s.c && s.c.name) || "Campaign",
  events: {
    "click [data-pick]": (e, el, ctx) => save(ctx, { audience: { ...ctx.state.c.audience, [el.dataset.pick]: toggle(ctx.state.c.audience[el.dataset.pick], el.dataset.value) } }),
    "click [data-flag]": (e, el, ctx) => { const a = { ...ctx.state.c.audience }; if (a[el.dataset.flag] === true) delete a[el.dataset.flag]; else a[el.dataset.flag] = true; return save(ctx, { audience: a }); },
    "click [data-plan]": (e, el, ctx) => { const a = { ...ctx.state.c.audience }; a.plan_status = (a.plan_status || []).includes(el.dataset.plan) ? [] : [el.dataset.plan]; return save(ctx, { audience: a }); },
    "change [data-template]": (e, el, ctx) => save(ctx, { template_key: el.value || null }),
    "change [data-notes]": (e, el, ctx) => save(ctx, { description: el.value }),
    "click [data-test]": async (e, el, ctx) => {
      const s = ctx.state;
      s.busy = "test"; ctx.rerender();
      // the audience is prepared in the background first; ask again until the test went out
      for (let i = 0; i < 12; i++) {
        const r = await act(ctx, "test", {});
        if (!r) break;
        if (r.data.status === "tested") { toast("Test sent to your test contact."); break; }
        await sleep(1500);
      }
      s.busy = "";
      ctx.refresh();
    },
    "click [data-now]": async (e, el, ctx) => {
      const n = (ctx.state.c.audience_preview && ((ctx.state.c.audience_preview.prepared || {}).count ?? ctx.state.c.audience_preview.count)) || 0;
      if (!(await confirmSheet(`This sends to ${n} people now. It can't be taken back.`, { title: "Send the campaign?", yes: "Send now" }))) return;
      if (await act(ctx, "schedule", { send_at: null }, "It's going out.")) ctx.refresh();
    },
    "click [data-schedule]": async (e, el, ctx) => {
      const v = (document.querySelector("[data-when]") || {}).value;
      if (!v) { toast("Pick a day and time first.", { bad: true }); return; }
      if (await act(ctx, "schedule", { send_at: new Date(v).toISOString() }, "Scheduled.")) ctx.refresh();
    },
    "click [data-unschedule]": async (e, el, ctx) => { if (await act(ctx, "schedule", { send_at: "unschedule" }, "Off the schedule.")) ctx.refresh(); },
    "click [data-cancel]": async (e, el, ctx) => {
      if (!(await confirmSheet("Nobody else will get it.", { title: "Cancel this campaign?", yes: "Cancel it", no: "Keep it", danger: true }))) return;
      if (await act(ctx, "cancel", {}, "Cancelled.")) ctx.refresh();
    },
    "click [data-refresh]": (e, el, ctx) => ctx.refresh(),
    "input [data-body]": (e, el, ctx) => { const box = document.querySelector("[data-cost-box]"); if (box) paintInto(box, costLine(ctx.state, el.value)); },
    "change [data-body]": (e, el, ctx) => save(ctx, { body: el.value }),
    "click [data-var]": (e, el, ctx) => {
      const ta = document.querySelector("[data-body]");
      if (!ta) return;
      const at = ta.selectionStart ?? ta.value.length;
      const v = el.dataset.var === "first_name" ? "{{first_name|there}}" : `{{${el.dataset.var}}}`;
      ta.value = ta.value.slice(0, at) + v + ta.value.slice(ta.selectionEnd ?? at);
      ta.focus();
      save(ctx, { body: ta.value });
    },
    "click [data-fu-on]": (e, el, ctx) => { const fu = ctx.state.c.followup || { after_hours: 48, body: "" }; save(ctx, { followup: { ...fu, on: !fu.on, body: fu.body || "Just checking in: still want a time for your windows? Reply YES and we'll set it up." } }); },
    "change [data-fu-after]": (e, el, ctx) => save(ctx, { followup: { ...ctx.state.c.followup, after_hours: Number(el.value) } }),
    "change [data-fu-body]": (e, el, ctx) => save(ctx, { followup: { ...ctx.state.c.followup, body: el.value } }),
    "click [data-csv]": async (e, el, ctx) => {
      const f = await capture({ accept: ".csv,text/csv", camera: false });
      if (!f) return;
      if (f.size > 400000) { toast("That file is too big (2,000 rows at most).", { bad: true }); return; }
      try {
        const r = await ctx.api(`/campaigns/${ctx.state.c.id}/audience/csv`, { method: "POST", body: { csv: await f.text() } });
        toast(`${r.data.csv.used} people from the file.`);
        ctx.refresh();
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-blast-pic]": async (e, el, ctx) => {
      const f = await capture({ accept: "image/*", camera: false });
      if (!f) return;
      try {
        const out = await uploadPhoto({ ownerType: "campaign", ownerId: ctx.state.c.id, kind: "attachment", file: f });
        await save(ctx, { media_file_ids: [out.file.id] });
        toast("Picture added.");
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-blast-win]": async (e, el, ctx) => {
      const list = ((await ctx.api("/campaigns/winners", { cache: false }).catch(() => ({ data: [] }))).data || []).filter((x) => x.body);
      const sh = sheet({
        title: "Start from a past winner",
        body: list.length ? html`<ul class="list">${list.map((x, i) => html`<li><button type="button" class="row" ${attrs({ "data-win": String(i) })}><span class="who"><span class="nm">${x.name}</span><span class="sub">${x.response_pct === null ? "No replies counted yet" : `${x.response_pct}% replied`} · ${x.sent} sent${x.job_revenue_cents ? ` · ${money(x.job_revenue_cents)} in jobs` : ""}</span><span class="sub two">${x.body}</span></span><span class="chev" aria-hidden="true"></span></button></li>`)}</ul>` : html`<p class="muted">Once a few campaigns have gone out, the ones people answered most show up here.</p>`,
        events: { "click [data-win]": (ev, b) => { const x = list[Number(b.dataset.win)]; sh.close(); if (x) save(ctx, { body: x.body }); } },
      });
    },
  },
};
