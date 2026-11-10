// Settings → Lead webhooks (design §6.7, D6; owners only): the links Zapier
// posts Meta lead-ad leads to ("Facebook Lead Ads → New Lead" → "Webhooks by
// Zapier → POST JSON"). A link is shown once when it is made (only a hash is
// kept), can be revoked, and lands each lead in the CRM as source Meta Ads
// with its form, ad and county; the same lead twice is one contact.

import { html, icon, sheet, toast, confirmSheet } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { dateShort } from "../../core/format.js";
import { ensureStyles, emptyCard } from "./kit.js";

function shownOnce(link) {
  const s = sheet({
    title: "Your webhook link",
    body: html`<p class="muted">Copy it now: it is shown only once. Paste it into Zapier's "Webhooks by Zapier → POST" step (payload type JSON).</p>
      <div class="copy-box"><input type="text" readonly value="${link.url}" aria-label="Webhook link" data-link><button type="button" class="btn dark" data-copy>${icon("copy")}Copy</button></div>
      <ol class="steps small" style="margin-top:14px">
        <li>Trigger: Facebook Lead Ads → New Lead (your page and form).</li>
        <li>Action: Webhooks by Zapier → POST, URL = the link above, payload JSON.</li>
        <li>Data: full_name, phone_number, email, street_address, city, zip_code, form_name, ad_name, campaign_name, where_are_you_located, and id (the lead id: a retry is then one contact).</li>
        <li>Test it: the lead shows up in Contacts.</li>
      </ol>`,
    events: {
      "click [data-copy]": async () => {
        const input = s.el.querySelector("[data-link]");
        try { await navigator.clipboard.writeText(link.url); toast("Copied"); } catch (e) { input.select(); toast("Press and hold the link to copy it."); }
      },
    },
  });
}

export default {
  title: "Lead webhooks",
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api("/intake/webhook-tokens", { cache: false });
    return { list: r.data || [] };
  },
  action(s, ctx) {
    return { label: "Make a link", run: () => {
      const sh = sheet({
        title: "New webhook link",
        body: html`<form class="form" id="hk-f" novalidate><div class="err" data-form-err hidden></div>
          ${field({ label: "Name (for you)", name: "label", value: "Meta leads (Zapier)" })}
          ${field({ label: "Source its leads get", name: "source", value: "Meta Ads" })}
          <button type="submit" class="btn primary block">Make the link</button></form>`,
        events: {
          "submit #hk-f": async (e, form) => {
            e.preventDefault(); clearErrors(form);
            const btn = form.querySelector("[type=submit]"); busy(btn, true);
            try { const r = await ctx.api("/intake/webhook-tokens", { method: "POST", body: readForm(form) }); sh.close(); shownOnce(r.data); ctx.refresh(); }
            catch (err) { busy(btn, false); showError(form, err); }
          },
        },
      });
    } };
  },
  render(s) {
    return html`<div class="stack">
      <div class="note">Meta lead-ad leads reach the CRM through Zapier (about a third of all leads). Rotor keeps getting them its own way until the switch-over.</div>
      ${s.list.length ? html`<ul class="list">${s.list.map((t) => html`<li><div class="row">
        <span class="ico">${icon("plug")}</span>
        <span class="who"><span class="nm">${t.label}</span><span class="sub">${t.source}${t.created_at ? " · made " + dateShort(t.created_at) : ""}</span></span>
        <span class="end"><button type="button" class="btn danger" data-revoke="${t.id}">Revoke</button></span>
      </div></li>`)}</ul>` : emptyCard("No webhook links yet", "Make one, then paste it into Zapier.", "plug")}
    </div>`;
  },
  events: {
    "click [data-revoke]": async (e, el, ctx) => {
      if (!(await confirmSheet("Leads sent to this link stop arriving. Zapier needs a new link.", { title: "Revoke this link?", yes: "Revoke", danger: true }))) return;
      try { await ctx.api(`/intake/webhook-tokens/${encodeURIComponent(el.dataset.revoke)}`, { method: "DELETE" }); toast("Revoked"); ctx.refresh(); }
      catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
