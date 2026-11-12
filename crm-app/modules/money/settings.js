// Settings → Payments (design §9.2 Settings, §13 D2; owners). The mode,
// said plainly: Dry run (nothing is charged, the default until the owner
// connects keys), Test (Stripe's test mode with a test key), Live (real
// cards; only after the switch from Rotor). Which keys Netlify has (names
// and kinds, never a value), the webhook addresses to give Stripe, and the
// money settings: tips, retries, reminders, the admin credit cap.

import { html, attrs, toast, confirmSheet } from "../../core/ui.js";
import { busy, readMoney } from "../../core/forms.js";
import { ensureStyles, MODE } from "./kit.js";

const dollars = (c) => (Number.isInteger(c) ? (c / 100).toFixed(2) : "");
const KEY_WORDS = { live: "a live key", test: "a test key", missing: "not set", other: "set, but not a Stripe key", set: "set" };
const REFUSED = {
  live_waits_for_cutover: "Live payments wait for the switch from Rotor. Until then everything stays in dry run.",
  live_key_in_test_slot: "STRIPE_TEST_SECRET_KEY holds a live key. Nothing will be charged with it. Put a test key there.",
  test_key_missing: "Test mode needs a test key in Netlify (STRIPE_TEST_SECRET_KEY).",
  test_key_in_live_slot: "STRIPE_SECRET_KEY holds a test key. Live mode needs the live key.",
  live_key_missing: "Live mode needs the live key in Netlify (STRIPE_SECRET_KEY).",
  not_production: "Only the live site can reach Stripe. This copy stays in dry run.",
};

async function load(params, ctx) {
  ensureStyles();
  const [st, cfg] = await Promise.all([ctx.api("/money/status", { cache: false }), ctx.api("/settings/money", { cache: false })]);
  return { st: st.data, cfg: { ...st.data.settings, ...(cfg.data.data || {}) }, etag: cfg.data.etag || "new" };
}

export default {
  load,
  render(s) {
    const st = s.st, c = s.cfg;
    const [label, words] = MODE[st.mode] || MODE.dry_run;
    const rotor = st.system_of_record !== "crm";
    return html`<div class="stack">
      <section class="card"><h2>Payments</h2>
        <div class="mn-mode"><span class="big" data-mode-now="${st.mode}">${label}</span>${st.mode === "live" ? html`<span class="pill green">Real money</span>` : html`<span class="pill amber">Nothing is charged for real</span>`}</div>
        <p>${words}</p>
        ${st.refused ? html`<p class="err">${REFUSED[st.refused] || String(st.refused).replace(/_/g, " ")}</p>` : ""}
        ${rotor ? html`<p class="small muted">Rotor is still in charge of billing. The CRM never charges a customer Rotor bills, and never touches a Stripe customer, card or payment it didn't make itself.</p>` : ""}
        <div class="mn-seg" role="group" aria-label="Payments mode">
          ${[["dry_run", "Dry run"], ["test", "Test"], ["live", "Live"]].map(([k, l]) => html`<button type="button" class="${"btn" + (st.wanted === k ? " primary" : "")}" ${attrs({ "data-mode": k, "aria-pressed": String(st.wanted === k), disabled: k === "live" && rotor })}>${l}</button>`)}
        </div>
        ${rotor ? html`<p class="small muted">Live turns on only after the switch from Rotor.</p>` : ""}
      </section>
      <section class="card"><h2>Stripe keys in Netlify</h2>
        <p class="small muted">Keys are set in Netlify (Production only), never here. This only shows which ones are there.</p>
        <dl class="kv">${Object.entries(st.keys || {}).map(([k, v]) => html`<dt>${k}</dt><dd>${KEY_WORDS[v] || v}</dd>`)}</dl>
        <p class="small muted">Webhook addresses to give Stripe: live <code>${st.webhooks.live}</code>, test <code>${st.webhooks.test}</code>.</p>
        ${st.foreign_events ? html`<p class="small muted">${st.foreign_events} Stripe event${st.foreign_events === 1 ? "" : "s"} about payments the CRM didn't make ${st.foreign_events === 1 ? "was" : "were"} ignored, as they should be.</p>` : ""}
      </section>
      <form class="form stack" data-money novalidate>
        <section class="card"><h2>Invoices</h2>
          <label class="check"><input type="checkbox" name="auto_issue" ${attrs({ checked: c.auto_issue !== false })}><span>Issue and send the invoice by itself when a visit is done</span></label>
          <label class="check"><input type="checkbox" name="receipt_email" ${attrs({ checked: c.receipt_email !== false })}><span>Email a receipt as well as texting it</span></label>
          <div class="mn-grid">
            <label class="field" data-field="overdue_every_days"><span>Remind every (days)</span><input name="overdue_every_days" inputmode="numeric" ${attrs({ value: c.overdue_every_days })}><small class="why" hidden></small></label>
            <label class="field" data-field="overdue_max"><span>Reminders at most</span><input name="overdue_max" inputmode="numeric" ${attrs({ value: c.overdue_max })}><small class="why" hidden></small></label>
          </div>
        </section>
        <section class="card"><h2>Tips</h2>
          <p class="small muted">Tips go to the techs on the visit, split evenly.</p>
          <div class="mn-grid">
            <label class="field" data-field="tip_options_bp"><span>Choices (percent)</span><input name="tips" autocomplete="off" ${attrs({ value: (c.tip_options_bp || []).map((b) => b / 100).join(", ") })}><small class="why" hidden></small></label>
            <label class="field" data-field="tip_custom_max_cents"><span>Largest custom tip</span><input name="tip_max" inputmode="decimal" ${attrs({ value: dollars(c.tip_custom_max_cents) })}><small class="why" hidden></small></label>
          </div>
        </section>
        <section class="card"><h2>Cards and bank</h2>
          <label class="check"><input type="checkbox" name="ach" ${attrs({ checked: c.ach !== false })}><span>Let customers pay from a bank account (it takes a few days to clear)</span></label>
          <div class="mn-grid">
            <label class="field" data-field="retry_days"><span>Retry a failed card after (days)</span><input name="retry_days" autocomplete="off" ${attrs({ value: (c.retry_days || []).join(", ") })}><small class="why" hidden></small></label>
            <label class="field" data-field="statement_descriptor"><span>On their statement</span><input name="statement_descriptor" maxlength="22" autocomplete="off" ${attrs({ value: c.statement_descriptor })}><small class="why" hidden></small></label>
          </div>
        </section>
        <section class="card"><h2>Credit</h2>
          <label class="field" data-field="credit_cap_admin_cents"><span>Largest credit an admin can give</span><input name="credit_cap" inputmode="decimal" ${attrs({ value: dollars(c.credit_cap_admin_cents) })}><small class="why" hidden></small></label>
        </section>
        <p class="err" data-form-err hidden></p>
        <button type="submit" class="btn primary block">Save</button>
      </form>
    </div>`;
  },
  events: {
    "click [data-mode]": async (e, el, ctx) => {
      const want = el.dataset.mode;
      if (want === ctx.state.st.wanted) return;
      const ask = { dry_run: "Nothing will be charged: payments go back to practice only.", test: "Stripe's test mode with the test key: no real money moves.", live: "Real cards will be charged from now on." }[want];
      if (!(await confirmSheet(ask, { title: `Switch payments to ${MODE[want][0]}?`, yes: "Switch", danger: want === "live" }))) return;
      busy(el, true);
      try {
        const r = await ctx.api("/money/payments-mode", { method: "POST", body: { mode: want } });
        toast(`Payments are in: ${(MODE[r.data.mode] || MODE.dry_run)[0]}`);
        ctx.refresh();
      } catch (err) { busy(el, false); toast(err.message || "That didn't change.", { bad: true }); }
    },
    "submit [data-money]": async (e, form, ctx) => {
      e.preventDefault();
      const f = (n) => form.elements[n];
      const err = form.querySelector("[data-form-err]");
      err.hidden = true;
      const nums = (v) => String(v || "").split(/[,\s]+/).filter(Boolean).map(Number);
      const body = {
        ...ctx.state.cfg,
        auto_issue: f("auto_issue").checked, receipt_email: f("receipt_email").checked, ach: f("ach").checked,
        overdue_every_days: Number(f("overdue_every_days").value), overdue_max: Number(f("overdue_max").value),
        tip_options_bp: nums(f("tips").value).map((p) => Math.round(p * 100)), tip_custom_max_cents: readMoney(f("tip_max").value || "0"),
        retry_days: nums(f("retry_days").value), statement_descriptor: f("statement_descriptor").value.trim(),
        credit_cap_admin_cents: readMoney(f("credit_cap").value || "0"),
      };
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        await ctx.api("/settings/money", { method: "PUT", ifMatch: ctx.state.etag, body });
        toast("Saved"); ctx.refresh();
      } catch (er) { busy(btn, false); err.textContent = er.status === 412 ? "Someone else just saved these. Reload and try again." : er.message; err.hidden = false; }
    },
  },
};
