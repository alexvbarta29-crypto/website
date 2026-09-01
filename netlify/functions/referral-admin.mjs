// Office side of the referral program (docs/REFERRAL-PROGRAM.md → Admin),
// used by admin/referrals.html:
//
//   GET  /api/referral/admin[?status=new&q=jane]   stats + referrals + referrers
//   GET  /api/referral/admin?format=csv            every referral as text/csv
//   POST /api/referral/admin  { action: set_status | issue_reward | set_note
//                                     | set_reward_pref | delete, … }
//
// Every request carries "Authorization: Bearer <REFERRAL_ADMIN_KEY>". A
// wrong or missing key is 401; a server without the key configured answers
// 503 so the dashboard can say "not set up yet" rather than "wrong key".
// The key is compared in constant time and never logged.

import { STATUSES, REWARD_TYPES, rewardAmount, rewardLabel } from "../lib/referral-config.mjs";
import {
  CAPS, clean, safeEqual, nowISO, historyEntry, newestFirst, adminStats, referrerSummary,
  matchesQuery, toCSV, isPlainObject, normalizePhone, safeErr,
} from "../lib/referral-lib.mjs";
import {
  openStore, allReferrals, allReferrers, getReferral, getReferrer, saveReferralRecord,
  saveReferrer, deleteReferral,
} from "../lib/referral-store.mjs";

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status, error, field) =>
  json(field ? { ok: false, error, field } : { ok: false, error }, status);

const ACTIONS = new Set(["set_status", "issue_reward", "set_note", "set_reward_pref", "delete"]);

export default async (req) => {
  const denied = authorize(req);
  if (denied) return denied;
  if (req.method !== "GET" && req.method !== "POST")
    return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, POST" });

  let store;
  try {
    store = await openStore();
    return req.method === "GET" ? await list(store, req) : await act(store, req);
  } catch (err) {
    console.error(`referral admin: ${req.method} failed (${safeErr(err)})`);
    return fail(503, "Referral storage is unavailable right now. Try again in a minute.");
  }
};

export const config = { path: "/api/referral/admin" };

function authorize(req) {
  const key = String(process.env.REFERRAL_ADMIN_KEY || "").trim();
  if (!key)
    return fail(503, "The admin key isn't configured on the server yet (set REFERRAL_ADMIN_KEY in Netlify).");
  const m = /^Bearer\s+(.+?)\s*$/i.exec(req.headers.get("authorization") || "");
  if (!m || !safeEqual(m[1], key))
    return json({ ok: false, error: "Unauthorized" }, 401,
      { "WWW-Authenticate": 'Bearer realm="referrals"' });
  return null;
}

// The office never needs a customer's private dashboard token.
const adminReferrer = ({ token, ...rest }) => rest;
const history = (r) => (Array.isArray(r.history) ? r.history : []);

// ---------------------------------------------------------------------------
// GET — list (+ filters) or CSV export
// ---------------------------------------------------------------------------
async function list(store, req) {
  const params = new URL(req.url).searchParams;
  const [referrals, referrers] = await Promise.all([allReferrals(store), allReferrers(store)]);
  referrals.sort(newestFirst);

  // The export is always everything, regardless of filters — it is the
  // office's spreadsheet backup.
  if ((params.get("format") || "").trim().toLowerCase() === "csv") {
    return new Response(toCSV(referrals), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="referrals-${nowISO().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Stats stay global so the tiles don't change when a filter is applied;
  // only the referral list narrows. An unknown status value means "all".
  const status = (params.get("status") || "").trim().toLowerCase();
  const q = params.get("q") || "";
  let rows = referrals;
  if (STATUSES.includes(status)) rows = rows.filter((r) => r.status === status);
  if (q.trim()) rows = rows.filter((r) => matchesQuery(r, q));

  referrers.sort(newestFirst);
  return json({
    ok: true,
    stats: adminStats(referrals),
    referrals: rows,
    referrers: referrers.map((p) => referrerSummary(p, referrals)),
  });
}

// ---------------------------------------------------------------------------
// POST — actions
// ---------------------------------------------------------------------------
async function act(store, req) {
  let body;
  try { body = await req.json(); } catch { body = null; }
  if (!isPlainObject(body)) return fail(400, "Invalid request body.");
  const action = clean(body.action);
  if (!ACTIONS.has(action)) return fail(400, "Unknown action.", "action");
  const now = nowISO();
  const note = clean(body.note);

  if (action === "set_reward_pref") {
    // referrer_id is the phone digits; a formatted phone is accepted too.
    const id = normalizePhone(body.referrer_id);
    const pref = clean(body.reward_pref).toLowerCase();
    if (!REWARD_TYPES.includes(pref))
      return fail(400, "reward_pref must be credit or giftcard.", "reward_pref");
    const referrer = id ? await getReferrer(store, id) : null;
    if (!referrer) return fail(404, "Referrer not found.", "referrer_id");
    referrer.reward_pref = pref;
    referrer.updated_at = now;
    await saveReferrer(store, referrer);
    return json({ ok: true, referrer: adminReferrer(referrer) });
  }

  // Only ids we mint (r_ + base36 + 6 random) ever reach the store, so a
  // crafted id can't be turned into some other record's key.
  const id = clean(body.id);
  if (!id) return fail(400, "id is required.", "id");
  const referral = /^r_[0-9a-z]+$/.test(id) ? await getReferral(store, id) : null;
  if (!referral) return fail(404, "Referral not found.", "id");

  switch (action) {
    case "set_status": {
      const status = clean(body.status).toLowerCase();
      if (!STATUSES.includes(status)) return fail(400, "Unknown status.", "status");
      // "rewarded" must go through issue_reward so the amount/type/date are
      // always recorded alongside it.
      if (status === "rewarded")
        return fail(400, "Use issue_reward to mark a referral rewarded.", "status");
      if (note.length > CAPS.note)
        return fail(400, `Note is too long (${CAPS.note} characters max).`, "note");
      // Moving a rewarded referral back means the reward was issued by
      // mistake; clearing it keeps the totals honest. The history keeps the trail.
      if (referral.status === "rewarded") referral.reward = null;
      referral.status = status;
      if (status === "quoted" && !referral.quote_requested_at) referral.quote_requested_at = now;
      referral.history = [...history(referral), historyEntry(status, "office", note, now)];
      referral.updated_at = now;
      await saveReferralRecord(store, referral);
      return json({ ok: true, referral });
    }
    case "issue_reward": {
      // Defaults to what the referrer asked for on the form.
      let type = clean(body.reward_type).toLowerCase();
      if (!type) {
        const referrer = await getReferrer(store, referral.referrer_id);
        type = referrer && referrer.reward_pref ? referrer.reward_pref : "";
      }
      if (!REWARD_TYPES.includes(type))
        return fail(400, "reward_type must be credit or giftcard.", "reward_type");
      if (note.length > CAPS.note)
        return fail(400, `Note is too long (${CAPS.note} characters max).`, "note");
      // Never pay twice by accident: to re-issue, the office moves the
      // referral back to Booked first.
      if (referral.status === "rewarded" && referral.reward)
        return fail(409, "A reward was already issued for this referral. Change its status first to issue a different one.");
      referral.reward = { type, amount: rewardAmount(type), issued_at: now, note };
      referral.status = "rewarded";
      referral.history = [...history(referral), historyEntry("rewarded", "office",
        [`Issued ${rewardLabel(type)}`, note].filter(Boolean).join(" — "), now)];
      referral.updated_at = now;
      await saveReferralRecord(store, referral);
      return json({ ok: true, referral });
    }
    case "set_note": {
      if (note.length > CAPS.office_note)
        return fail(400, `Note is too long (${CAPS.office_note} characters max).`, "note");
      referral.office_note = note;
      referral.updated_at = now;
      await saveReferralRecord(store, referral);
      return json({ ok: true, referral });
    }
    case "delete": {
      await deleteReferral(store, referral);
      return json({ ok: true, deleted: referral.id });
    }
    default:
      return fail(400, "Unknown action.", "action");
  }
}
