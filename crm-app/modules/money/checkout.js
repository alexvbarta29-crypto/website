// Checkout (Flyra's phone checkout, the owner's screenshot of Nov 15, "best
// of both" with Rotor's payment sheet): a sheet with the grabber, a round X
// and "Checkout" in the middle; "Your service" (the lines, Subtotal, the
// discount in green, the Service total highlighted); "Tip your crew" (the
// tip on the right, the visit's technician, None | 10% | 15% | 20% | Other
// with each amount under it); the totals (Service total, Tip, Total); the
// way to pay with a blue "Change" (Tap to Pay, the card on file, cash or a
// check, a pay link); and the sticky "Pay $X".
//
// The job page's Checkout and the invoice's "Checkout with a tip" open it:
//   openCheckout({ api, invoiceId })  or  openCheckout({ api, jobId })
// (a job's invoice is found, or made as a draft, then marked sent silently
// before a payment). A tip rides on the payment (tip_cents) and the server
// splits it across the job's technicians, as every tip. Nothing real moves
// until Stripe is live (dry run); Tap to Pay needs Stripe Terminal, which
// isn't connected, so it says so.

import { html, attrs, sheet, toast, actionSheet } from "../../core/ui.js";
import { busy, readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, MI, waitRun } from "./kit.js";
import { cardWords } from "./invoice-acts.js";

const TIPS = [["0", "None"], ["1000", "10%"], ["1500", "15%"], ["2000", "20%"], ["other", "Other"]];
const WAY = {
  tap: { label: "Tap to Pay", sub: "Hold the card near the phone", icon: MI.tap },
  card: { label: "Card on file", sub: "", icon: MI.card },
  cash: { label: "Cash or check", sub: "Write down what they handed you", icon: MI.dollar },
  send: { label: "Send link", sub: "They pay on their own phone", icon: MI.mail },
};
const pct = (due, bp) => Math.floor((due * bp + 5000) / 10000);       // half up, whole cents

function stateOf(s) {
  const c = s.can || {};
  const way = c.charge && s.card && s.card.usable ? "card" : c.record ? "cash" : c.send || c.issue ? "send" : "tap";
  return { s, tip: "0", other: "", way, cash: "cash", ref: "" };
}
const dueOf = (s) => (s.invoice.status === "draft" ? s.invoice.total_cents : s.invoice.balance_cents) || 0;
const tipsOk = (s) => !["deposit", "fee"].includes(s.invoice.kind);
function tipOf(st) {
  if (!tipsOk(st.s) || st.way === "send") return 0;
  const due = dueOf(st.s);
  if (st.tip === "other") { const v = readMoney(st.other); return v && v > 0 ? Math.min(v, due) : 0; }
  return pct(due, Number(st.tip) || 0);
}
// can this way pay now? → null or why not
function blocked(st) {
  const c = st.s.can || {};
  const inv = st.s.invoice;
  const draft = inv.status === "draft";
  if (st.way === "tap") return "Tap to Pay needs Stripe Terminal, which isn't connected yet. Pick another way to pay.";
  if (st.way === "card") return (draft || c.charge) && st.s.card && st.s.card.usable && st.s.online !== "not_yet" ? null : st.s.online === "not_yet" ? "Rotor still bills this customer: card charges open after the switch." : "No card on file to charge.";
  if (st.way === "cash") return draft || c.record ? null : "Nothing is left to record on this invoice.";
  return draft || c.send || c.issue ? null : "This invoice can't be sent now.";
}

function view(st) {
  const s = st.s;
  const inv = s.invoice;
  const lines = inv.lines || [];
  const items = lines.filter((l) => ["service", "fee"].includes(l.kind || "service"));
  const disc = -lines.filter((l) => l.kind === "discount").reduce((a, l) => a + (l.total_cents || 0), 0);
  const cred = -lines.filter((l) => ["credit", "deposit_credit"].includes(l.kind)).reduce((a, l) => a + (l.total_cents || 0), 0);
  const paid = (inv.paid_cents || 0) - (inv.refunded_cents || 0);
  const due = dueOf(s);
  const tip = tipOf(st);
  const q = (l) => { const n = (l.qty_milli ?? 1000) / 1000; return Number.isInteger(n) ? n : +n.toFixed(2); };
  const crew = s.crew || [];
  const who = crew.length ? crew.map((x) => x.name).join(" and ") : "Your crew";
  const w = WAY[st.way];
  const why = blocked(st);
  const sub = st.way === "card" ? cardWords(s) : w.sub;
  return html`<div class="mn-co">
    <section class="rs-card mn-co-card">
      <h3>Your service</h3>
      <ul class="mn-co-items">${items.map((l) => html`<li><span class="mn-co-q">${q(l)}×</span><span class="d">${l.description}</span><span class="num">${money(l.total_cents)}</span></li>`)}</ul>
      <div class="mn-co-r b"><span>Subtotal</span><span class="num">${money(inv.subtotal_cents || 0)}</span></div>
      ${disc ? html`<div class="mn-co-r"><span>Discount</span><span class="num green">−${money(disc)}</span></div>` : ""}
      ${cred ? html`<div class="mn-co-r"><span>Credit</span><span class="num green">−${money(cred)}</span></div>` : ""}
      ${paid ? html`<div class="mn-co-r"><span>Paid already</span><span class="num">−${money(paid)}</span></div>` : ""}
      <div class="mn-co-r hi"><span>Service total</span><span class="num">${money(due)}</span></div>
    </section>
    ${tipsOk(s) ? html`<section class="rs-card mn-co-card">
      <div class="mn-co-th"><h3>Tip your crew</h3><span class="num mn-co-tv" data-co-tipv>${money(tip)}</span></div>
      <div class="mn-co-crew"><span class="mn-co-av" aria-hidden="true">${(crew[0] && crew[0].name ? crew[0].name[0] : "B").toUpperCase()}</span><span><b>${who}</b><small>${crew.length === 1 ? "Your technician today" : "Your crew today"}</small></span></div>
      ${st.way === "send" ? html`<p class="mn-co-note">They pick a tip on their own phone when they pay the link.</p>` : html`<div class="mn-co-tips" role="radiogroup" aria-label="Tip">${TIPS.map(([k, l]) => html`<button type="button" role="radio" ${attrs({ class: "mn-co-tip" + (st.tip === k ? " on" : ""), "data-co-tip": k, "aria-checked": st.tip === k ? "true" : "false" })}><span>${l}</span>${k !== "0" && k !== "other" ? html`<small class="num">${money(pct(due, Number(k)))}</small>` : ""}</button>`)}</div>
      ${st.tip === "other" ? html`<label class="field mn-co-other"><span>Tip amount</span><input name="tip_other" inputmode="decimal" autocomplete="off" placeholder="0.00" data-co-other ${attrs({ value: st.other })}></label>` : ""}`}
    </section>` : ""}
    <section class="rs-card mn-co-card">
      <div class="mn-co-r"><span>Service total</span><span class="num">${money(due)}</span></div>
      <div class="mn-co-r"><span>Tip</span><span class="num" data-co-tip2>${money(tip)}</span></div>
      <div class="mn-co-r tot"><span>Total</span><span class="num" data-co-tot>${money(due + tip)}</span></div>
      <div class="mn-co-way"><span class="mn-co-wi" aria-hidden="true">${w.icon}</span><span class="mn-co-wt"><b>${w.label}</b><small>${sub}</small></span><button type="button" class="mn-co-change" data-co-change>Change</button></div>
      ${st.way === "cash" ? html`<div class="mn-co-cash">
        <div class="mn-seg mn-seg2" role="radiogroup" aria-label="Cash or check">${[["cash", "Cash"], ["check", "Check"]].map(([k, l]) => html`<label><input type="radio" name="co_cash" ${attrs({ value: k, checked: st.cash === k })}><span>${l}</span></label>`)}</div>
        ${st.cash === "check" ? html`<label class="field"><span>Check number</span><input name="co_ref" autocomplete="off" maxlength="60" data-co-ref ${attrs({ value: st.ref })}></label>` : ""}
      </div>` : ""}
      ${why ? html`<p class="mn-co-note" data-co-why>${why}</p>` : s.payments_mode !== "live" && st.way !== "send" ? html`<p class="mn-co-note">Payments are practice right now: nothing real is charged.</p>` : ""}
    </section>
    <div class="mn-co-cta"><button type="button" class="mn-co-pay" data-co-pay ${attrs({ disabled: !!why })}>${w.icon}<span data-co-paylabel>${st.way === "send" ? `Send ${money(due)} link` : `Pay ${money(due + tip)}`}</span></button></div>
  </div>`;
}

async function invoiceFor(api, { invoiceId, jobId }) {
  let id = invoiceId;
  if (!id && jobId) {
    const r = await api(`/jobs/${encodeURIComponent(jobId)}/invoice`, { method: "POST", body: { issue: false } });
    id = r.data.invoice.id;
  }
  const g = await api(`/invoices/${encodeURIComponent(id)}`, { cache: false });
  return { ...g.data, etag: g.etag || g.data.etag };
}

// openCheckout({ api, invoiceId | jobId, onDone? }) → Promise<the sheet | null>
export async function openCheckout({ api, invoiceId = null, jobId = null, onDone } = {}) {
  ensureStyles();
  let s;
  try { s = await invoiceFor(api, { invoiceId, jobId }); } catch (err) { toast(err.message || "That invoice didn't load.", { bad: true }); return null; }
  if (s.rotor_owned) { toast("This invoice is still Rotor's until the switch: take payment in Rotor.", { bad: true }); return null; }
  if (!["draft", "open"].includes(s.invoice.status) || !(dueOf(s) > 0)) { toast(s.invoice.status === "paid" ? "This invoice is paid." : "There's nothing to pay on this invoice."); return null; }
  const st = stateOf(s);
  const clientId = uuid();
  const id = () => encodeURIComponent(st.s.invoice.id);
  const draw = () => sh.set(view(st));
  const relabel = () => {
    const due = dueOf(st.s), tip = tipOf(st);
    const set = (sel, v) => { const el = sh.el.querySelector(sel); if (el) el.textContent = v; };
    set("[data-co-tipv]", money(tip)); set("[data-co-tip2]", money(tip)); set("[data-co-tot]", money(due + tip));
    if (st.way !== "send") set("[data-co-paylabel]", `Pay ${money(due + tip)}`);
  };
  const sh = sheet({
    title: "Checkout",
    className: "mn-cosheet",
    body: view(st),
    events: {
      "click [data-co-tip]": (e, el) => { st.tip = el.dataset.coTip; draw(); if (st.tip === "other") { const i = sh.el.querySelector("[data-co-other]"); if (i) i.focus(); } },
      "input [data-co-other]": (e, el) => { st.other = el.value; relabel(); },
      "input [data-co-ref]": (e, el) => { st.ref = el.value; },
      "change [name=co_cash]": (e, el) => { st.cash = el.value; draw(); },
      "click [data-co-change]": () => {
        actionSheet("Pay with", [Object.entries(WAY).map(([k, w]) => ({ label: w.label, hint: k === "card" ? cardWords(st.s) : k === "tap" ? "Not connected yet" : "", icon: k === "card" ? "pay" : k === "cash" ? "money" : k === "send" ? "send" : "phone", run: () => { st.way = k; draw(); } }))]);
      },
      "click [data-co-pay]": async (e, btn) => {
        if (btn.disabled) return;
        const tip = tipOf(st);
        busy(btn, true, st.way === "card" ? "Charging…" : st.way === "send" ? "Sending…" : "Saving…");
        try {
          // a draft is marked sent first (silently: the customer is right there)
          if (st.s.invoice.status === "draft" && st.way !== "send") {
            await api(`/invoices/${id()}/mark-sent`, { method: "POST", body: {} });
            st.s = await invoiceFor(api, { invoiceId: st.s.invoice.id });
          }
          if (st.way === "card") {
            const r = await api(`/invoices/${id()}/charge`, { method: "POST", body: tip ? { tip_cents: tip } : {} });
            const run = await waitRun(api, r.data.run_id);
            const res = run && run.result && run.result.status;
            toast(res === "succeeded" ? "Paid. Thank you!" : res === "processing" ? "The bank payment is clearing" : res === "failed" ? "The card didn't go through" : res === "would_charge" ? "Not charged: Rotor still bills this customer" : "Still working. Check back in a minute.", { bad: !["succeeded", "processing"].includes(res) });
          } else if (st.way === "cash") {
            await api(`/invoices/${id()}/payments`, { method: "POST", body: { method: st.cash, amount_cents: st.s.invoice.balance_cents, tip_cents: tip, reference: st.ref || undefined, client_id: clientId }, idempotencyKey: clientId });
            toast("Payment saved");
          } else if (st.way === "send") {
            const ct = st.s.contact || {};
            const channels = [ct.has_sms ? "sms" : null, ct.has_email ? "email" : null].filter(Boolean);
            if (!channels.length) { busy(btn, false); toast("No mobile number or email on file to send it to.", { bad: true }); return; }
            await api(`/invoices/${id()}/${st.s.invoice.status === "draft" ? "issue" : "send"}`, { method: "POST", body: { channels } });
            toast(st.s.system_of_record !== "crm" ? "In the Outbox" : "Sent");
          }
          sh.close();
          if (onDone) onDone(st.way);
        } catch (err) { busy(btn, false); toast(err.message || "That didn't work.", { bad: true }); }
      },
    },
  });
  return sh;
}
