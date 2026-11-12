// Money module: scan to pay (Flyra's "scan to pay"; design §9.2 Visit →
// Collect payment, D38). The office's Invoice screen and the visit's
// Collect payment show a QR code of the customer's own pay page, so they
// pay at the door on their own phone, tip and all.
//
// The QR is a portal link like the one the invoice text carries (scope
// "invoice": that one invoice, nothing else; the same lifetime; kept only
// as a hash), made fresh each time it is shown, and marked as the QR's
// (created_by "qr:{who}"), so an open of it is a scan and a payment that
// starts there carries via: "qr". Nothing here moves money: the pay page
// and Checkout are the money module's as ever (dry run until the owner
// connects keys; before the switch from Rotor only sandboxed customers).
//
//   qrPayLink(inv, by)                 → { code, url, expires_at }
//   qrRefusal(inv, sor)                → null | { code, message } (why the screen shows no QR)
//   viaQr(session, invoiceId)          → true when the portal session came from a QR link
//   noteQrShown(id, by, ctx) · noteQrOpened(id, ctx)   the invoice's `qr` history (best effort)

import { getRaw, updateRecord } from "../../../crm-store.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { createPortalLink } from "../../portal/core.mjs";
import { invoiceLinkExpiry } from "./automations.mjs";
import { payRefusal } from "./checkout.mjs";
import { W } from "./common.mjs";

export const QR_BY = "qr:";
// A second open within this long is the same scan (a reload, the back button).
export const OPEN_DEBOUNCE_MS = 2 * 60 * 1000;

export async function qrPayLink(inv, by = "system") {
  return createPortalLink({ contact_id: inv.contact_id, scope: { kind: "invoice", id: inv.id }, expires_at: await invoiceLinkExpiry(), created_by: `${QR_BY}${String(by).slice(0, 60)}` });
}
export const isQrLink = (link) => !!link && typeof link.created_by === "string" && link.created_by.startsWith(QR_BY);

// What the staff screen says instead of a QR. The customer's page says its
// own words (checkout.mjs payRefusal); these are for the person holding the phone.
const STAFF = {
  rotor_owns: "This invoice is still Rotor's until the switch, so it has no pay code here.",
  draft: "This invoice is a draft. Send it or issue it first.",
  paid: "This invoice is paid. Nothing to scan.",
  void: "This invoice was voided. Nothing to scan.",
  uncollectible: "This invoice was written off. Nothing to scan.",
  nothing: "Nothing is left to pay on this invoice.",
  not_yet: "Rotor still bills this customer, so paying by card opens after the switch. Take cash or a check.",
  charging: "A card charge is running on this invoice right now. Check again in a minute.",
  processing: "A bank payment is clearing for this invoice (a few days). No pay code until it does.",
  paused: "Online payment is paused right now. Take cash or a check.",
};
export async function qrRefusal(inv, sor) {
  if (!inv || inv.deleted_at) return { code: "missing", message: "That invoice isn't here." };
  if (inv.import && sor !== "crm") return { code: "rotor_owns", message: STAFF.rotor_owns };
  if (["draft", "paid", "void", "uncollectible"].includes(inv.status)) return { code: inv.status, message: STAFF[inv.status] };
  const why = await payRefusal(inv, { sor });
  if (!why) return null;
  const code = why.code === "paid" ? "nothing" : why.code;
  return { code, message: STAFF[code] || why.message };
}

// The link a portal session was opened with (a hub session carries the
// links of the documents it was handed). → its stored record | null
async function linkOf(session, invoiceId) {
  if (!session || !session.scope) return null;
  let hash = null;
  if (session.scope.kind === "invoice" && session.scope.id === invoiceId) hash = session.link;
  else if (session.scope.kind === "hub" && Array.isArray(session.grants)) {
    const g = session.grants.filter((x) => x && x.kind === "invoice" && x.id === invoiceId && Date.parse(x.until) > nowMs()).pop();
    hash = g && g.link;
  }
  if (!/^[0-9a-f]{64}$/.test(String(hash || ""))) return null;
  const got = await getRaw(`plk/${hash}`).catch(() => null);
  return got && got.data ? got.data : null;
}
export async function viaQr(session, invoiceId) {
  const link = await linkOf(session, invoiceId);
  return !!link && isQrLink(link) && !!link.scope && link.scope.kind === "invoice" && link.scope.id === invoiceId;
}

// ------------------------------------------------------------ the invoice's QR history

const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null) delete o[k]; return o; };

// Staff showed the code (the Invoice screen or Collect payment).
export async function noteQrShown(invoiceId, by, ctx = {}) {
  const at = nowIso();
  return updateRecord("invoice", invoiceId, (inv) => {
    const q = inv.qr || {};
    return { ...inv, qr: clean({ ...q, shown: (q.shown || 0) + 1, last_shown_at: at, last_shown_by: typeof by === "string" ? by.slice(0, 80) : undefined }) };
  }, W(ctx));
}

// The customer's phone opened the pay page from the code (the page's beacon,
// a POST after it loads: link previews and scanners open nothing).
export async function noteQrOpened(invoiceId, ctx = {}) {
  const at = nowIso();
  return updateRecord("invoice", invoiceId, (inv) => {
    const q = inv.qr || {};
    if (q.last_opened_at && nowMs() - Date.parse(q.last_opened_at) < OPEN_DEBOUNCE_MS) return null;
    return { ...inv, qr: clean({ ...q, opened: (q.opened || 0) + 1, first_opened_at: q.first_opened_at || at, last_opened_at: at }) };
  }, W(ctx));
}
