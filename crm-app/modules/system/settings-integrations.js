// Settings → Integrations and Intake mode (design §6.1, §6.8, §3.10;
// owners only). Integrations: per service the mode it is set to and the mode
// it really runs in now, and which secrets Netlify has (names, yes/no,
// never a value). Nothing reaches a customer before the switch-over: "live"
// acts as "test" (staff numbers only), and texts and emails stay in the
// outbox until the Messages module connects Twilio and Postmark. Web push
// goes to staff phones as soon as the VAPID keys exist.
// Intake mode: where website leads go (Rotor, both, the CRM); "both" and
// "the CRM" work since the Contacts module (M2a).

import { html, attrs, toast, icon } from "../../core/ui.js";
import { readForm, clearErrors, showError, busy, select, field } from "../../core/forms.js";
import { modePill, loadDoc, saveDoc } from "./kit.js";

const NAMES = { sms: "Texts (Twilio)", email: "Email (Postmark)", payments: "Payments (Stripe)", maps: "Maps (Google)", reviews: "Google reviews", meta: "Meta leads", push: "Push to staff phones" };
const MODES = [{ value: "off", label: "Off" }, { value: "dry_run", label: "Dry run (outbox only)" }, { value: "test", label: "Test (staff only)" }, { value: "live", label: "Live" }];
const list = (s) => String(s || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
// "(763) 555-0150" → "+17635550150" (what the server keeps)
const e164 = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : String(s || "").trim(); };

function integrations(s) {
  const st = s.status.integrations;
  const set = s.doc.data;
  return html`<div class="stack">
    <div class="note">Rotor is still in charge: nothing reaches a customer before the switch-over. Live acts as test (staff only), and texts and emails wait in the Outbox.${s.status.force_dry_run ? " Sending is held off for this whole site." : ""}${s.status.paused ? " The CRM is paused." : ""}</div>
    <form class="stack" id="f" novalidate>
      <div class="err" data-form-err hidden></div>
      ${Object.keys(NAMES).map((k) => {
        const i = st[k] || { secrets: {} };
        const conf = set[k] || {};
        return html`<section class="card form">
          <div class="row" style="padding:0;min-height:0"><span class="who"><span class="nm">${NAMES[k]}</span><span class="sub">Running now: ${modePill(i.effective)}${i.waiting_for ? html` <span class="small muted">(waiting for its module)</span>` : ""}</span></span></div>
          ${select({ label: "Mode", name: `${k}_mode`, value: conf.mode || i.setting, options: MODES })}
          <div class="stat-row">${Object.entries(i.secrets || {}).map(([n, ok]) => html`<span class="pill ${ok ? "green" : "red"}">${ok ? "✓" : "✕"} ${n}</span>`)}</div>
          ${k === "sms" ? html`${field({ label: "Public number", name: "sms_number", type: "tel", value: conf.number || "" })}
            ${field({ label: "Test number (before the switch-over)", name: "sms_test_from", type: "tel", value: conf.test_from || "" })}
            <label class="field" data-field="sms.test_allowlist"><span>Staff numbers test texts may go to (+1 and 10 digits)</span><textarea name="sms_allow" rows="2">${(conf.test_allowlist || []).join("\n")}</textarea><small class="why" hidden></small></label>` : ""}
          ${k === "email" ? html`${field({ label: "From", name: "email_from", value: conf.from || "" })}
            ${field({ label: "Reply-to", name: "email_reply_to", type: "email", value: conf.reply_to || "" })}
            <label class="field" data-field="email.test_allowlist"><span>Staff emails test emails may go to</span><textarea name="email_allow" rows="2">${(conf.test_allowlist || []).join("\n")}</textarea><small class="why" hidden></small></label>` : ""}
        </section>`;
      })}
      <button type="submit" class="btn primary block">Save</button>
    </form>
    <p class="small muted">Secrets live in Netlify (Site configuration → Environment variables), Production only. This page only shows whether each one is there.</p>
  </div>`;
}

function intake(s, ctx) {
  const mode = s.doc.data.mode || "rotor";
  const opts = [
    { value: "rotor", label: "Rotor only (today)", sub: "Website leads go to Rotor, as now." },
    { value: "dual", label: "Rotor and the CRM", sub: "Both get every lead until the switch-over. Rotor stays first and the website's answer stays Rotor's." },
    { value: "crm", label: "The CRM only", sub: "After the switch-over." },
  ];
  return html`<div class="stack"><form class="card form" id="f" novalidate>
    <div class="err" data-form-err hidden></div>
    <p class="small">Where the website's quote form, the giveaway and referrals send new leads.</p>
    ${opts.map((o) => html`<label class="check"><input ${attrs({ type: "radio", name: "mode", value: o.value, checked: mode === o.value })}><span><b>${o.label}</b><br><span class="small muted">${o.sub}</span></span></label>`)}
    <button type="submit" class="btn primary block">Save</button>
  </form></div>`;
}

export default {
  async load(params, ctx) {
    if (ctx.path.endsWith("/intake")) return { section: "intake", doc: await loadDoc(ctx, "intake") };
    const [r, doc] = await Promise.all([ctx.api("/admin/integrations", { cache: false }), loadDoc(ctx, "integrations")]);
    return { section: "integrations", status: r.data, doc };
  },
  render(s, ctx) { return s.section === "intake" ? intake(s, ctx) : integrations(s); },
  events: {
    "submit #f": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      const s = ctx.state;
      try {
        if (s.section === "intake") {
          await saveDoc(ctx, s.doc, { ...s.doc.data, mode: v.mode });
        } else {
          const d = { ...s.doc.data };
          for (const k of Object.keys(NAMES)) d[k] = { ...(d[k] || {}), mode: v[`${k}_mode`] };
          d.sms = { ...d.sms, number: v.sms_number ? e164(v.sms_number) : null, test_from: v.sms_test_from ? e164(v.sms_test_from) : null, test_allowlist: list(v.sms_allow).map(e164) };
          d.email = { ...d.email, from: v.email_from || d.email.from, reply_to: v.email_reply_to || d.email.reply_to, test_allowlist: list(v.email_allow) };
          await saveDoc(ctx, s.doc, d);
        }
        toast("Saved");
        ctx.refresh();
      } catch (err) {
        busy(btn, false);
        if (err.status !== 412) showError(form, err);
      }
    },
  },
};
