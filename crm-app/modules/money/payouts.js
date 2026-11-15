// Payouts (the Rotor guide's FO1, S19): Stripe's deposits to the bank by
// the day they arrive, read only. Until an owner connects a read-only
// Stripe key, one card says where that's done; nothing here ever moves
// money.

import { html, listRow, listCard, emptyCard } from "../../core/ui.js";
import { money, dateShort } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

const ST = { paid: ["Paid", "green"], in_transit: ["In transit", "blue"], pending: ["Pending", "amber"], failed: ["Failed", "red"], canceled: ["Cancelled", "grey"] };

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api("/payouts", { cache: false });
  return { rows: r.data || [], meta: r.meta || {} };
}

export default {
  title: "Payouts",
  load,
  render(s, ctx) {
    if (!s.meta.connected) {
      return html`<div class="stack">${emptyCard({ icon: "money", title: "Payouts show here once Stripe is connected", text: "An owner adds a read-only Stripe key (Settings → Payments). Until then nothing is read from Stripe.", action: ctx.can("settings:owner") ? { label: "Settings → Payments", href: "#/settings/payments", icon: "gear" } : null })}</div>`;
    }
    return html`<div class="stack">
      ${s.meta.note ? html`<p class="foot-note">${s.meta.note}</p>` : ""}
      ${listCard(s.rows.map((p) => {
        const [w, tone] = ST[p.st] || [p.st, "grey"];
        return listRow({ title: `Arrives ${dateShort(p.arr)}`, amount: p.a || 0, sub: [p.n ? `${p.n} payment${p.n === 1 ? "" : "s"}` : null, p.fee ? `fees ${money(p.fee)}` : null].filter(Boolean).join(" · "), pill: { label: w, tone } });
      }), { label: "Payouts", empty: "No payouts yet this year." })}
    </div>`;
  },
};
