// Settings → Messages → Muted contacts (Rotor's muted list: guide-gaps
// §2.15 ST7): everyone whose automated texts or email are paused. Their
// own texts from a person still go. Unmute here, or on their page.

import { html, toast, listCard, listRow, emptyCard } from "../../core/ui.js";
import { ensureStyles } from "./kit.js";

const CH = { sms: "texts", email: "email" };

export default {
  title: "Muted contacts",
  async load(params, ctx) {
    ensureStyles();
    return (await ctx.api("/comms/muted", { cache: false })).data;
  },
  render(s) {
    if (!s.indexed && !s.list.length) return html`<div class="stack">${emptyCard({ icon: "pause", title: "No list yet", text: "This list fills in once the customers list carries who is muted (the Customers update). Until then, a customer's page shows Mute and Unmute." })}</div>`;
    return html`<div class="stack">
      <p class="small muted">Reminders, follow-ups and other automatic messages skip these people. A text someone on the team sends by hand still goes.</p>
      ${s.list.length ? listCard(s.list.map((c) => listRow({ title: c.name || "No name", sub: [c.town, `Muted ${c.channels.map((k) => CH[k] || k).join(" and ")}`].filter(Boolean).join(" · "), href: "#/contacts/" + encodeURIComponent(c.id), action: { icon: "undo", label: `Unmute ${c.name}`, data: { unmute: c.id } } })), { label: "Muted contacts" })
        : emptyCard({ icon: "pause", title: "Nobody is muted", text: "Mute someone from their page, or from the person button in their Inbox thread." })}
    </div>`;
  },
  events: {
    "click [data-unmute]": async (e, el, ctx) => {
      e.preventDefault();
      const c = ctx.state.list.find((x) => x.id === el.dataset.unmute);
      if (!c) return;
      el.disabled = true;
      try {
        for (const ch of c.channels) await ctx.api(`/contacts/${encodeURIComponent(c.id)}/automations-paused`, { method: "PATCH", body: { channel: ch, paused: false } });
        ctx.state.list = ctx.state.list.filter((x) => x.id !== c.id);
        toast("Unmuted");
        ctx.rerender();
      } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
