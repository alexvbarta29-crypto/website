// Settings → Messages → Business numbers (the Rotor guide's Engagement:
// guide-gaps §2.15 ST8, ST23, S6, S50): the numbers texts and calls go
// from, which one each kind of message uses, the From address for email,
// and what a text costs (the text blast's cost line). Nothing is bought or
// changed at Twilio from here; while texting isn't connected every send is
// a dry run (the Outbox) and Rotor keeps the real number.

import { html, attrs, toast, formRow, formRows, toggle, sectionLabel, pillBtn } from "../../core/ui.js";
import { phone as fmtPhone } from "../../core/format.js";
import { loadDoc, saveDoc } from "../system/kit.js";
import { ensureStyles } from "./kit.js";

const USES = [["inbox", "Inbox"], ["automations", "Automatic texts"], ["dialer", "Power Dialer"]];

export default {
  title: "Business numbers",
  async load(params, ctx) {
    ensureStyles();
    const [eng, price] = await Promise.all([loadDoc(ctx, "engagement"), loadDoc(ctx, "sms_pricing")]);
    return { eng, price, rows: (eng.data.numbers || []).map((n) => ({ ...n })) };
  },
  render(s) {
    const p = s.price.data;
    return html`<form class="stack" data-num-f novalidate>
      <div class="note">Rotor still has the business number. These are the numbers the CRM will text and call from once Twilio is connected; until then everything you send waits in the Outbox.</div>
      ${s.rows.map((n, i) => html`${sectionLabel(n.label || `Number ${i + 1}`)}${formRows([
        formRow("Number", html`<input type="tel" ${attrs({ name: `e164_${i}`, value: n.e164 ? fmtPhone(n.e164) : "", placeholder: "(763) 555-0100", autocomplete: "off", inputmode: "tel" })}>`),
        formRow("Name", html`<input type="text" maxlength="30" ${attrs({ name: `label_${i}`, value: n.label || "", placeholder: "Main line" })}>`),
        formRow("Texts", toggle(n.sms !== false, { data: { "num-sms": String(i) }, label: "Texts from this number" })),
        ...USES.map(([k, l]) => formRow(`${l} use it`, toggle((n.default_for || []).includes(k), { data: { "num-use": `${i}:${k}` }, label: `${l} use this number` }))),
        formRow("", pillBtn("Remove this number", { icon: "trash", data: { "num-del": String(i) } })),
      ])}`)}
      ${s.rows.length < 10 ? pillBtn("Add a number", { icon: "plus", data: { "num-add": true }, wide: true }) : ""}
      ${sectionLabel("Email")}
      ${formRows([formRow("From address", html`<input type="email" name="email_from" autocomplete="off" ${attrs({ value: s.eng.data.email_from || "", placeholder: "office@example.com" })}>`, { hint: "Empty: the company email" })])}
      ${sectionLabel("What a text costs")}
      ${formRows([
        formRow("Per text (cents)", html`<input type="text" inputmode="decimal" name="per_segment_cents" ${attrs({ value: String(p.per_segment_cents) })}>`, { hint: "Each 160 characters is one text" }),
        formRow("Picture text (cents)", html`<input type="text" inputmode="decimal" name="mms_cents" ${attrs({ value: String(p.mms_cents) })}>`),
      ])}
      <button type="submit" class="btn primary block">Save</button>
    </form>`;
  },
  events: {
    "click [data-num-add]": (e, el, ctx) => { ctx.state.rows.push({ e164: "", label: "", sms: true, default_for: ctx.state.rows.length ? [] : ["inbox", "automations", "dialer"] }); ctx.rerender(); },
    "click [data-num-del]": (e, el, ctx) => { ctx.state.rows.splice(Number(el.dataset.numDel), 1); ctx.rerender(); },
    "click [data-num-sms]": (e, el, ctx) => { const n = ctx.state.rows[Number(el.dataset.numSms)]; n.sms = !(n.sms !== false); el.setAttribute("aria-checked", String(n.sms)); },
    "click [data-num-use]": (e, el, ctx) => {
      const [i, k] = el.dataset.numUse.split(":");
      // one number per use: taking it here takes it off the others
      ctx.state.rows.forEach((n, j) => { const has = (n.default_for || []).includes(k); n.default_for = (n.default_for || []).filter((u) => u !== k); if (j === Number(i) && !has) n.default_for.push(k); });
      ctx.rerender();
    },
    "submit [data-num-f]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      s.rows.forEach((n, i) => { n.e164 = form.querySelector(`[name=e164_${i}]`).value; n.label = form.querySelector(`[name=label_${i}]`).value; });
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await saveDoc(ctx, s.eng, { ...s.eng.data, numbers: s.rows.filter((n) => String(n.e164).trim()), email_from: form.querySelector("[name=email_from]").value.trim() });
        await saveDoc(ctx, s.price, { per_segment_cents: form.querySelector("[name=per_segment_cents]").value, mms_cents: form.querySelector("[name=mms_cents]").value });
        s.rows = (s.eng.data.numbers || []).map((n) => ({ ...n }));
        toast("Saved");
        ctx.rerender();
      } catch (err) { if (err.status !== 412) toast(err.message, { bad: true }); }
      btn.disabled = false;
    },
  },
};
