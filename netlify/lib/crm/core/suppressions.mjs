// Barta CRM core: the suppression list (design §5.7.2 "suppression beats
// consent", §3.3 sup/, §11.3 consent.changed).
//
// sup/{channel}/{hk} = { state: "opted_out", at, source, masked, by?,
// contact_id?, keyword?, n, rel_sort } is what the sender checks before
// every text or email. Every change goes through setSuppression():
//
// - opting out writes sup/ (CAS) and a dated row
//   rel/suppressions/{channel}/{tsKey}--{hk}, so Settings → Messaging lists
//   the newest first (a listing of sup/ is in hash order);
// - opting back in ("active") deletes sup/ and its row;
// - each change emits consent.changed { id: "sup.{channel}.{hk}", wv: n,
//   contact_id, channel, address_hk, state }, so sales (stop enrollments)
//   and comms (stop the review sequence) hear about it (§11.3). The contact
//   is the one the caller knows (a portal link's) or the first contact
//   ptr/phone|email/{hk} names; null when nobody has that address.
//
// Callers: the portal unsubscribe (one-click and the page), POST
// /suppressions (staff), and inbound STOP/START (comms, M6).

import { getRaw, settledWrite, deleteRaw, addRel, removeRel, listRel, readPointer, appendEvent } from "../../crm-store.mjs";
import { nowIso, now, tsKey } from "./clock.mjs";
import { isId } from "./ids.mjs";
import { InputError, StaleError } from "./errors.mjs";
import { keySafe } from "./text.mjs";
import { emit } from "./events.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const SUP_CHANNELS = Object.freeze(["sms", "email"]);
export const SUP_STATES = Object.freeze(["opted_out", "active"]);
export const supKey = (channel, addrHk) => `sup/${channel}/${addrHk}`;
const HK_RE = /^[0-9a-z]{16,64}$/;

// The contact an address belongs to, when the caller does not know it.
async function contactFor(channel, addrHk) {
  const p = await readPointer(channel === "sms" ? "phone" : "email", addrHk).catch(() => null);
  const ids = p && Array.isArray(p.ids) ? p.ids.filter((x) => isId(x, "contact")) : [];
  return ids[0] || null;
}

// Opts an address out (state "opted_out") or back in ("active").
// → { changed, state, value }
export async function setSuppression({ channel, address_hk: addrHk, state, source = "manual", masked, by, contact_id, keyword } = {}) {
  if (!SUP_CHANNELS.includes(channel)) throw new InputError("Pick text or email.", "channel");
  if (!SUP_STATES.includes(state)) throw new InputError("Opted out or active.", "state");
  if (typeof addrHk !== "string" || !HK_RE.test(addrHk)) throw new InputError("That address isn't right.", "address");
  const k = supKey(channel, addrHk);
  let value = null;
  let changed = false;
  for (let i = 0; i < 4 && !value; i++) {
    const cur = await getRaw(k);
    const d = cur && cur.data ? cur.data : null;
    if (state === "active") {
      if (!d) { value = { state: "active" }; break; }
      await deleteRaw(k);
      if (d.rel_sort) await removeRel("suppressions", channel, d.rel_sort, addrHk).catch(() => {});
      value = { state: "active", n: (d.n || 0) + 1 };
      changed = true;
      break;
    }
    if (d && d.state === "opted_out") { value = d; break; }
    const at = nowIso();
    const next = {
      state: "opted_out", at, source: keySafe(source, 20), masked: (d && d.masked) || masked || (channel === "sms" ? "(•••) •••-••••" : "•••@•••"),
      ...(by ? { by: String(by).slice(0, 60) } : {}), ...(isId(contact_id, "contact") ? { contact_id } : {}), ...(keyword ? { keyword: keySafe(keyword, 20) } : {}),
      n: ((d && d.n) || 0) + 1, rel_sort: tsKey(now()),
    };
    const w = await settledWrite(k, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (!w.ok) continue;
    if (d && d.rel_sort) await removeRel("suppressions", channel, d.rel_sort, addrHk).catch(() => {});
    await addRel("suppressions", channel, next.rel_sort, addrHk).catch(() => {});
    value = next;
    changed = true;
  }
  if (!value) throw new StaleError(null, null, "The opt-out list kept changing. Try again.");
  if (changed) {
    await appendEvent("sup", addrHk, { action: state === "active" ? "unsuppress" : "suppress", by: by || "system", origin: source === "portal" ? "portal" : "api", channel }).catch(() => {});
    try {
      const cid = isId(contact_id, "contact") ? contact_id : await contactFor(channel, addrHk);
      await emit("consent.changed", { id: `sup.${channel}.${addrHk}`, wv: value.n || 1, contact_id: cid, channel, address_hk: addrHk, state }, { by: by || "system" });
    } catch (e) {
      // the opt-out itself is what matters: the sender already honours it
      console.error(`crm:suppressions: consent.changed not emitted (${safeErr(e)})`);
    }
  }
  return { changed, state, value };
}

// Settings → Messaging: the newest opt-outs first. → { items, next }
export async function listSuppressions(channel, { limit = 40, before } = {}) {
  if (!SUP_CHANNELS.includes(channel)) throw new InputError("Pick text or email.", "channel");
  const rows = (await listRel("suppressions", channel, { to: before, limit: limit + 1 })).filter((r) => !before || r.sortKey < before);
  const page = rows.slice(0, limit);
  const got = await Promise.all(page.map((r) => getRaw(supKey(channel, r.id)).catch(() => null)));
  const seen = new Set();
  const items = [];
  page.forEach((r, i) => {
    const d = got[i] && got[i].data;
    if (!d || d.state !== "opted_out" || d.rel_sort !== r.sortKey || seen.has(r.id)) return;
    seen.add(r.id);
    items.push({ hash: r.id, channel, masked: d.masked || "•••", state: d.state, at: d.at || null, source: d.source || null, keyword: d.keyword || null });
  });
  return { items, next: rows.length > limit ? page[page.length - 1].sortKey : null };
}
