// Settings → Texting, email & reviews (design §6.1, §6.3, §6.4, D1, D4):
// where each stands, what an owner still has to do, and the addresses to
// paste into Twilio and Postmark when the time comes. Read-only: the modes
// themselves are under Settings → Integrations (owners).

import { html, icon } from "../../core/ui.js";
import { ensureStyles } from "./kit.js";

const MODE = { dry_run: ["Dry run", ""], test: ["Test", "blue"], live: ["Live", "green"], off: ["Off", ""] };
const pill = (m) => html`<span class="${"pill " + ((MODE[m] || [])[1] || "")}">${(MODE[m] || [m])[0]}</span>`;
const step = (ok, text) => html`<li class="row" style="cursor:default"><span class="${"pill " + (ok ? "green" : "amber")}">${ok ? "Done" : "To do"}</span><span class="who"><span class="nm" style="white-space:normal">${text}</span></span></li>`;

export default {
  async load(params, ctx) {
    ensureStyles();
    return (await ctx.api("/comms/setup", { cache: false })).data;
  },
  render(s) {
    const rotor = s.system_of_record !== "crm";
    return html`<div class="stack">
      <div class="note">${rotor ? "Rotor still sends every text and email to customers. Here nothing leaves the CRM until an owner connects the accounts, and even then test mode only reaches the team's own phones." : "The CRM is the system of record."}</div>
      <section class="card stack"><div class="stack-head"><h2>Texting (Twilio)</h2>${pill(s.sms.effective)}</div>
        <ul class="list">
          ${step(s.sms.account && s.sms.token, "Twilio account keys in Netlify (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN), Production only")}
          ${step(s.sms.test_number, "A separate Twilio test number (Settings → Integrations)")}
          ${step(s.sms.allowlist > 0, `The team's phones on the test list (${s.sms.allowlist} so far)`)}
          ${step(s.sms.effective === "test" || s.sms.effective === "live", "Texting set to Test (Settings → Integrations)")}
        </ul>
        <p class="small">When the test number is set up in Twilio, paste these as its webhooks. The CRM never changes anything in Twilio itself, and Rotor keeps (763) 314-3400 until you move it.</p>
        <div class="small muted">A message comes in</div><div class="cm-url">${s.sms.inbound_url}</div>
        <div class="small muted">Delivery status</div><div class="cm-url">${s.sms.status_url}</div>
        <p class="small muted">${s.sms.advanced_opt_out ? "STOP, START and HELP are answered by Twilio's Advanced Opt-Out; the CRM records them. Remove YES from its opt-in words: Barta's texts ask people to reply YES for a quote." : "The CRM answers HELP itself (the help_reply template)."}</p>
      </section>
      <section class="card stack"><div class="stack-head"><h2>Email (Postmark)</h2>${pill(s.email.effective)}</div>
        <ul class="list">
          ${step(s.email.token, "Postmark server token in Netlify (POSTMARK_SERVER_TOKEN)")}
          ${step(s.email.webhook_token, "A webhook token in Netlify (POSTMARK_WEBHOOK_TOKEN)")}
          ${step(s.email.allowlist > 0, `The team's addresses on the test list (${s.email.allowlist} so far)`)}
        </ul>
        <div class="small muted">Delivery, bounce and complaint webhook (with your token at the end)</div><div class="cm-url">${s.email.webhook_url}</div>
      </section>
      <section class="card stack"><div class="stack-head"><h2>Google reviews</h2>${pill(s.reviews.effective)}</div>
        <ul class="list">${step(s.reviews.keys, "Google keys in Netlify (the same ones the website's reviews page uses)")}${step(s.reviews.effective === "live", "Reviews set to Live (Settings → Integrations)")}</ul>
        <p class="small muted">Read-only: the CRM matches reviews to customers and stops their review requests. It never replies to a review and never posts.</p>
      </section>
      <a class="btn block" href="#/settings/integrations">${icon("plug")}Open Integrations</a>
    </div>`;
  },
};
