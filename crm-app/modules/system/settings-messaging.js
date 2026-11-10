// Settings → Messaging (design §9.2, §5.7.2, §7.5, D5, D12, D17, D23):
// quiet hours, the opt-out footer, the bulk threshold, the duplicate
// window, reply keywords, and (owners) the test contact every bulk send
// goes to first. settings:messaging; the test contact is settings:owner.

import { html, attrs, toast } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy, checkbox } from "../../core/forms.js";
import { timeField, pickContact } from "../../core/pickers.js";
import { loadDoc, saveDoc } from "./kit.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default {
  title: "Messaging",
  async load(params, ctx) {
    const owner = ctx.can("settings:owner");
    const [messaging, comms, test] = await Promise.all([loadDoc(ctx, "messaging"), loadDoc(ctx, "comms"), owner ? loadDoc(ctx, "messaging_test") : null]);
    return { messaging, comms, test, testName: null, words: [...((comms.data.reply_keywords && comms.data.reply_keywords.words) || [])] };
  },
  render(s, ctx) {
    const m = s.messaging.data;
    const q = m.quiet || {};
    const mk = q.marketing || {};
    const rk = s.comms.data.reply_keywords || {};
    const testId = s.test && s.test.data.contact_id;
    return html`<div class="stack">
      <form class="card form" id="f" novalidate>
        <div class="err" data-form-err hidden></div>
        <h2>Quiet hours</h2>
        <p class="small">Texts outside these hours wait for the next allowed minute; nothing is dropped. A person's own texts go any time.</p>
        <div class="section-h">Service texts (reminders, receipts, reviews)</div>
        <div class="grid2">${timeField({ label: "From", name: "svc_from", value: (q.service || {}).from })}${timeField({ label: "To", name: "svc_to", value: (q.service || {}).to })}</div>
        <div class="section-h">Follow-up texts (cadences)</div>
        <div class="grid2">${timeField({ label: "From", name: "cad_from", value: (q.cadence || {}).from })}${timeField({ label: "To", name: "cad_to", value: (q.cadence || {}).to })}</div>
        <div class="section-h">Marketing</div>
        <div class="grid2">${timeField({ label: "From", name: "mk_from", value: mk.from })}${timeField({ label: "To", name: "mk_to", value: mk.to })}</div>
        <div class="stat-row" role="group" aria-label="Marketing days">${DOW.map((d, i) => html`<label class="chip"><input ${attrs({ type: "checkbox", name: `mk_day_${i}`, checked: (mk.days || [1, 2, 3, 4, 5, 6]).includes(i) })}> ${d}</label>`)}</div>
        ${checkbox({ label: "Never on holidays", name: "mk_skip_holidays", checked: mk.skip_holidays !== false })}
        <h2>Opt-out footer</h2>
        <p class="small">Templates never say it; the app adds it.</p>
        ${field({ label: "Footer", name: "footer_text", value: (m.footer || {}).text || " Reply STOP to opt out." })}
        ${checkbox({ label: "On the first text to a number from each sending number", name: "footer_first", checked: (m.footer || {}).first_per_number !== false })}
        ${checkbox({ label: "On every marketing text", name: "footer_marketing", checked: (m.footer || {}).marketing !== false })}
        <h2>Sending to many people</h2>
        ${field({ label: "More people than this needs a test send and a confirm", name: "bulk_threshold", value: String(m.bulk_threshold ?? 5), inputmode: "numeric" })}
        ${field({ label: "Same text to the same number again within (minutes) is blocked", name: "duplicate_window_min", value: String(m.duplicate_window_min ?? 10), inputmode: "numeric" })}
        ${field({ label: "Days between two campaigns to one person", name: "campaign_gap_days", value: String(m.campaign_gap_days ?? 3), inputmode: "numeric" })}
        ${checkbox({ label: "Typed texts only to people who texted first (Rotor's rule)", name: "inbound_first_only", checked: !!m.inbound_first_only })}
        <h2>Reply keywords</h2>
        <p class="small">STOP, START and HELP always work. These tag the contact and make a task for the owners.</p>
        ${checkbox({ label: "Turn reply keywords on", name: "rk_enabled", checked: !!rk.enabled })}
        <ul class="list">${s.words.map((w, i) => html`<li><div class="row"><span class="who"><span class="nm mono">${w.word}</span><span class="sub">Tag: ${w.tag || "none"}${w.task ? " · task" : ""}</span></span><span class="end"><button type="button" class="btn" data-del-word="${String(i)}">Remove</button></span></div></li>`)}</ul>
        <div class="grid2">${field({ label: "Word", name: "new_word", autocapitalize: "characters" })}${field({ label: "Tag", name: "new_tag" })}</div>
        <button type="button" class="btn" data-add-word>Add keyword</button>
        <button type="submit" class="btn primary block">Save</button>
      </form>
      ${s.test ? html`<div class="card">
        <h2>Test contact</h2>
        <p class="small">Every bulk send goes to this contact first, and can't go out until it has. Pick someone on the team whose contact is marked as a test contact.</p>
        <p><b>${testId ? (s.testName || (s.test.labels && s.test.labels.contact_id) || "A test contact") : "Not chosen yet"}</b></p>
        <div class="btn-row"><button type="button" class="btn dark" data-pick-test>Pick the test contact</button>${testId ? html`<button type="button" class="btn" data-clear-test>Clear</button>` : ""}</div>
      </div>` : ""}
    </div>`;
  },
  events: {
    "click [data-add-word]": (e, el, ctx) => {
      const form = el.closest("form");
      const word = String(form.querySelector("[name=new_word]").value || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{1,20}$/.test(word)) { toast("One word, letters and digits.", { bad: true }); return; }
      ctx.state.words = [...ctx.state.words.filter((w) => w.word !== word), { word, tag: String(form.querySelector("[name=new_tag]").value || "").trim(), task: true }];
      ctx.rerender();
    },
    "click [data-del-word]": (e, el, ctx) => {
      const i = Number(el.getAttribute("data-del-word"));
      ctx.state.words = ctx.state.words.filter((_, n) => n !== i);
      ctx.rerender();
    },
    "submit #f": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      const s = ctx.state;
      const n = (x, d) => (String(x || "").trim() === "" ? d : Number(x));
      try {
        await saveDoc(ctx, s.messaging, {
          ...s.messaging.data,
          quiet: {
            ...(s.messaging.data.quiet || {}),
            service: { from: v.svc_from, to: v.svc_to },
            cadence: { from: v.cad_from, to: v.cad_to },
            marketing: { from: v.mk_from, to: v.mk_to, days: DOW.map((_, i) => i).filter((i) => v[`mk_day_${i}`]), skip_holidays: !!v.mk_skip_holidays },
          },
          footer: { text: v.footer_text.startsWith(" ") ? v.footer_text : " " + v.footer_text, first_per_number: !!v.footer_first, marketing: !!v.footer_marketing },
          bulk_threshold: n(v.bulk_threshold, 5), duplicate_window_min: n(v.duplicate_window_min, 10), campaign_gap_days: n(v.campaign_gap_days, 3),
          inbound_first_only: !!v.inbound_first_only,
        });
        await saveDoc(ctx, s.comms, { ...s.comms.data, reply_keywords: { enabled: !!v.rk_enabled, words: s.words } });
        toast("Saved");
        busy(btn, false);
      } catch (err) {
        busy(btn, false);
        if (err.status !== 412) showError(form, err);
      }
    },
    "click [data-pick-test]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Test contact" });
      if (!c) return;
      try {
        await saveDoc(ctx, ctx.state.test, { ...ctx.state.test.data, contact_id: c.id });
        ctx.state.testName = c.name;
        toast("Test contact set");
        ctx.rerender();
      } catch (err) { if (err.status !== 412) toast(err.message, { bad: true }); }
    },
    "click [data-clear-test]": async (e, el, ctx) => {
      try {
        await saveDoc(ctx, ctx.state.test, { ...ctx.state.test.data, contact_id: null });
        toast("Cleared");
        ctx.rerender();
      } catch (err) { if (err.status !== 412) toast(err.message, { bad: true }); }
    },
  },
};
