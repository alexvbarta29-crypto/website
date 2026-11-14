// The switch-over runbook (design §10.9 "Runbook", §11.6; owners): the
// steps of switch day in order, Central time, in plain words, each with a
// link to where it's done in the CRM. What is done in Rotor, at Twilio or in
// Netlify is the owner's: the CRM never touches Rotor. docs/CRM-CUTOVER.md
// is the same runbook, longer.

import { html, attrs } from "../../core/ui.js";
import { ensureStyles } from "./kit.js";

export const STEPS = Object.freeze([
  { when: "Weeks before", what: "Make the automatic daily import key (Import from Rotor, Automatic daily import) and give it to the scheduled job that exports Rotor read-only every day. Each night's import keeps the CRM current.", link: "/import/auto", label: "Automatic daily import" },
  { when: "Weeks before", what: "Work the owner items: Stripe live in Barta's account, the Twilio hosting order for 314-3400 timed for Monday 06:00, 10DLC approved, email domain verified, the Meta lead path tested, agreement templates approved.", link: "/cutover", label: "Checklist" },
  { when: "Jan 1-2", what: "Compare the CRM's Jan 1 billing preview with Rotor's Jan 1 charges, line by line. Tick it when they match.", link: "/autopay", label: "Autopay" },
  { when: "Sun 18:00", what: "The final full export from Rotor (read-only) and the switch-day photo copy (build/crm_media_copy.mjs with --switch-day), then pack and upload.", link: "/import", label: "Imports" },
  { when: "Mon 06:00", what: "A last export since Sunday, the final import. Settle anything on the Conflicts screen. Twilio moves 314-3400's texting at 06:00: from then on Rotor can't text from it.", link: "/import", label: "Imports" },
  { when: "Mon 06:30", what: "Make the preview on the final import. Read the counts per day; approve them when they look right.", link: "/cutover/preview", label: "Preview" },
  { when: "Mon 07:00", what: "Documents in flight: make each list (quotes, invoices, agreements), test-send it to yourself and confirm it under Approvals.", link: "/approvals", label: "Approvals" },
  { when: "Before 09:45", what: "In Rotor, switch off its workflows yourself (new-lead text, reminders, overdue texts) and tick that box. Then, in one sitting, tap Switch to the CRM and type SWITCH TO CRM.", link: "/cutover", label: "Switch" },
  { when: "Right after", what: "Smoke tests: a text and an email to your test contact, the one-dollar live charge and its refund, a website test lead, a text and a STOP from a staff phone, a push to each owner.", link: "/outbox", label: "Outbox" },
  { when: "10:00", what: "The first reminder batch goes out from the CRM. Watch the Outbox, the automation log and Settings, Data today.", link: "/automations", label: "Automations" },
  { when: "First 48 hours", what: "If something is badly wrong: Switch back to Rotor (type SWITCH BACK TO ROTOR), turn Rotor's workflows back on, and enter what the CRM made meanwhile in Rotor. A later switch is a new one, numbered after the first.", link: "/cutover", label: "Switch" },
  { when: "Until Jan 11", what: "Check Rotor's inbox twice a day for replies that landed before the number moved. Keep Rotor readable at least 30 days for a last messages import.", link: "/import", label: "Imports" },
  { when: "Feb 3", what: "Cancel Rotor yourself, only after the last messages import.", link: null, label: null },
]);

export default {
  title: "Switch-over runbook",
  async load() { ensureStyles(); return {}; },
  render() {
    return html`<div class="stack">
      <section class="card">
        <h2>Switch day, step by step</h2>
        <p class="small muted">Times are Central. The switch is Monday January 4, before the 10:00 reminder batch. Nothing the CRM does changes Rotor: the Rotor steps are yours.</p>
        <ol class="co-steps">${STEPS.map((s) => html`<li><b>${s.when}.</b> ${s.what}${s.link ? html` <a ${attrs({ href: "#" + s.link })}>${s.label}</a>` : ""}</li>`)}</ol>
      </section>
      <div class="btn-row"><a class="btn primary" href="#/cutover">Back to the switch</a></div>
    </div>`;
  },
};
