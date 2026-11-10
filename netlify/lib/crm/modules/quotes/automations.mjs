// Quotes module: the quote.sent automation and the quotes.expire sweep
// (design §5.7.4, §7.6).
//
//   quote.sent     event:quote.sent, right away: one message per channel the
//                  person picked (SMS quote_sent and/or email quote_sent_email,
//                  service), the portal link inline (B10). The link is made
//                  when the automation runs (a bearer secret: never stored on
//                  the quote) and lasts until expires_on + cfg/portal
//                  lifetimes.quote_after_expiry_days. Shown in person or
//                  approved by phone (no channels): nothing is sent. Through
//                  the core sender: dry-run (Outbox only) until cutover.
//   quotes.expire  fast lane, daily 02:10: open quotes past expires_on are
//                  archived ("expired"); a quote the import brought in only
//                  gets a would- row before cutover (§0 rule 12).

import { getRecord, getSetting } from "../../../crm-store.mjs";
import { addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { createPortalLink } from "../../portal/core.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { dateWords } from "./render.mjs";
import { expireSweep } from "./quotes.mjs";

const TEMPLATE = { sms: "quote_sent", email: "quote_sent_email" };

export async function quoteSentRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const channels = (Array.isArray(p.channels) ? p.channels : []).filter((c) => TEMPLATE[c]);
  if (!channels.length) { await actx.log(p.quote_id, "skipped:no_channels"); return { result: "skipped:no_channels" }; }
  const g = await getRecord("quote", p.quote_id).catch(() => null);
  const q = g && g.data;
  if (!q || q.deleted_at || !["sent", "viewed"].includes(q.status) || (p.version_id && q.current_version_id !== p.version_id)) {
    await actx.log(p.quote_id, "skipped:changed");
    return { result: "skipped:changed" };
  }
  const portal = await getSetting("portal").catch(() => ({}));
  const days = (portal && portal.lifetimes && portal.lifetimes.quote_after_expiry_days) || 30;
  const until = q.expires_on ? zonedToUtc(addLocalDays(q.expires_on, days), "23:59").toISOString() : undefined;
  let link;
  try {
    link = await createPortalLink({ contact_id: q.contact_id, scope: { kind: "quote", id: q.id }, ...(until ? { expires_at: until } : {}), created_by: "automation:quote.sent" });
  } catch (e) {
    console.error(`crm:quotes: no quote link (${safeErr(e)})`);
    throw e;
  }
  let queued = 0;
  for (const ch of channels) {
    const r = await actx.send({
      contact_id: q.contact_id, subject: { type: "quote", id: q.id }, key: `${q.id}--${String(input.event.event_id || p.wv || "x").slice(0, 30)}--${ch}`,
      channel: ch, template_key: TEMPLATE[ch], vars: { quote_link: link.url, expires_on: q.expires_on ? dateWords(q.expires_on) : null }, related: { quote_id: q.id },
    });
    if (r.queued) queued += 1;
  }
  return { result: queued ? `queued:${queued}` : "skipped:not_queued" };
}

// Re-checked when the send is due: a quote that was approved, archived or
// re-sent since then isn't texted the old link.
export async function quoteSentRecheck(item) {
  const id = item && item.data && item.data.related && item.data.related.quote_id;
  const g = id ? await getRecord("quote", id).catch(() => null) : null;
  if (!g || g.data.deleted_at || !["sent", "viewed"].includes(g.data.status)) return { skip: "changed" };
  return {};
}

export const automations = [{
  key: "quote.sent", label: "Send the quote link", trigger: "event:quote.sent", category: "service", imported: "no", mutates: false,
  defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["quote_sent", "quote_sent_email"] },
  run: quoteSentRun, recheck: quoteSentRecheck,
}];

export const sweeps = [
  { key: "quotes.expire", label: "Expired quotes", lane: "fast", every: "daily", at_local: "02:10", mutates: true, run: (ctx) => expireSweep(ctx) },
];
