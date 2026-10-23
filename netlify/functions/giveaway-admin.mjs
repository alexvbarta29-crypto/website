// Office side of the Holiday Lights Giveaway (docs/GIVEAWAY.md), used by
// /admin/giveaway.html:
//
//   GET  /api/giveaway/admin               stats, entrants (with entry counts), the drawing
//   GET  /api/giveaway/admin?format=csv    every entrant, with personalised texts, as CSV
//   POST /api/giveaway/admin {action, …}   draw | redraw | undo_draw | send_batch | mark_sent
//                                          | set_note | disqualify | set_opt_out | update | resync_rotor
//                                          | delete | delete_all
//
// Auth: "Authorization: Bearer <key>", where the key is GIVEAWAY_ADMIN_KEY,
// or REFERRAL_ADMIN_KEY when that isn't set, so the office can use the key
// it already has for the referral dashboard.

import { GIVEAWAY, BROADCASTS, SMS, DATES, TAGS } from "../lib/giveaway-config.mjs";
import {
  entryCounts, draw, broadcastAudience, renderText, toCSV, eligible, addressLine, isOpen,
  areaCheck, householdKey, CAPS,
} from "../lib/giveaway-lib.mjs";
import {
  openStore, allEntrants, allOutside, getEntrant, saveEntrantRecord, deleteEntrant,
  deleteEverything, getDraw, saveDraw, clearDraw, idForHousehold, putJSON, KEYS,
} from "../lib/giveaway-store.mjs";
import { sendSms, e164 } from "../lib/referral-notify.mjs";
import { upsertGiveawayLead, rotorEntryPayload, rotorClaimPayload } from "../lib/giveaway-rotor.mjs";
import { clean, safeEqual, nowISO, safeErr, fullName } from "../lib/referral-lib.mjs";

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status, error) => json({ ok: false, error }, status);

const twilioReady = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
const MAX_BATCH = 25;

export default async (req) => {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const store = await openStore();
    if (req.method === "GET") return await list(store, req);
    if (req.method === "POST") return await act(store, req);
    return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  } catch (err) {
    console.error(`giveaway admin: ${req.method} failed (${safeErr(err)})`);
    return fail(503, "Giveaway storage is unavailable right now. Try again in a minute.");
  }
};

export const config = { path: "/api/giveaway/admin" };

function authorize(req) {
  const key = String(process.env.GIVEAWAY_ADMIN_KEY || process.env.REFERRAL_ADMIN_KEY || "").trim();
  if (!key) return fail(503, "The admin key isn't configured on the server yet (set REFERRAL_ADMIN_KEY in Netlify).");
  const m = /^Bearer\s+(.+?)\s*$/i.exec(req.headers.get("authorization") || "");
  if (!m || !safeEqual(m[1], key)) return fail(401, "Wrong admin key.");
  return null;
}

const newestFirst = (a, b) => String(b.created_at).localeCompare(String(a.created_at));

function adminRow(e, counts, winners) {
  return {
    id: e.id, first_name: e.first_name, last_name: e.last_name, phone: e.phone,
    address: addressLine(e.address), area: e.area, code: e.code,
    street: (e.address && e.address.street) || "", city: (e.address && e.address.city) || "",
    zip: (e.address && e.address.zip) || "",
    coupon_claimed_by: e.coupon ? e.coupon.by || "" : "",
    entries: counts.get(e.id) || 0, referred_by: e.referred_by,
    winner: winners.get(e.id) || null,
    sms: e.sms || {}, sms_opt_out: Boolean(e.sms_opt_out),
    coupon_claimed_at: e.coupon ? e.coupon.claimed_at : null,
    rotor_delivered: Boolean(e.rotor && e.rotor.delivered),
    rotor_lead_id: (e.rotor && e.rotor.lead_id) || null,
    rotor_existing: Boolean(e.rotor && e.rotor.existing),
    offers_opt_in: Boolean(e.offers_opt_in),
    disqualified: Boolean(e.disqualified), office_note: e.office_note || "",
    created_at: e.created_at,
    texts: Object.fromEntries(["nudge", "coupon", "followup24", "followup48"]
      .map((t) => [t, renderText(t, e, counts)])),
    winner_text: winners.has(e.id)
      ? SMS.winner({ first: e.first_name, bonus: winners.get(e.id) === "bonus" }) : null,
  };
}

async function list(store, req) {
  const url = new URL(req.url);
  const [entrants, drawResult, outside] = await Promise.all([
    allEntrants(store), getDraw(store), allOutside(store),
  ]);
  entrants.sort(newestFirst);
  const counts = entryCounts(entrants);
  if (url.searchParams.get("format") === "csv") {
    return new Response(toCSV(entrants, counts, drawResult), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
                 "Content-Disposition": 'attachment; filename="giveaway-entrants.csv"' },
    });
  }
  const winners = new Map((drawResult ? drawResult.winners : []).map((w) => [w.id, w.kind]));
  const totalEntries = [...counts.values()].reduce((s, c) => s + c, 0);
  const viaLink = entrants.filter((e) => e.referred_by).length;
  return json({
    ok: true,
    config: { ...GIVEAWAY, dates: DATES, open: isOpen() },
    sms_ready: twilioReady(),
    stats: {
      entrants: entrants.length,
      entries: totalEntries,
      via_link: viaLink,
      unverified: entrants.filter((e) => e.area && e.area.ok === null).length,
      claimed: entrants.filter((e) => e.coupon && e.coupon.claimed_at).length,
      offers_opt_in: entrants.filter((e) => e.offers_opt_in).length,
      outside: outside.length,
      winners: winners.size,
      opted_out: entrants.filter((e) => e.sms_opt_out).length,
      disqualified: entrants.filter((e) => e.disqualified).length,
      not_in_rotor: entrants.filter((e) => !(e.rotor && e.rotor.delivered)).length,
    },
    audiences: Object.fromEntries(BROADCASTS.map((t) => [t, broadcastAudience(t, entrants, drawResult).length])),
    draw: drawResult,
    entrants: entrants.map((e) => adminRow(e, counts, winners)),
    outside: outside.sort(newestFirst).map((o) => ({
      first_name: o.first_name, last_name: o.last_name, phone: o.phone,
      address: addressLine(o.address), miles: o.area ? o.area.miles : null, created_at: o.created_at,
    })),
  });
}

// ---------------------------------------------------------------------------
async function act(store, req) {
  let body;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== "object") return fail(400, "Invalid request.");
  const id = clean(body.id);
  const one = async () => {
    const e = /^\d{10}$/.test(id) ? await getEntrant(store, id) : null;
    if (!e) throw Object.assign(new Error("not found"), { status: 404 });
    return e;
  };
  try {
    switch (body.action) {
      case "draw": return await doDraw(store, body);
      case "redraw": return await doRedraw(store, id);
      case "undo_draw":
        if (body.confirm !== "UNDO DRAW") return fail(400, 'Type "UNDO DRAW" to confirm.');
        await clearDraw(store);
        return json({ ok: true, draw: null });
      case "send_batch": return await sendBatch(store, body);
      case "mark_sent": {
        const t = clean(body.template);
        if (![...BROADCASTS, "winner", "welcome"].includes(t)) return fail(400, "Unknown text.");
        const e = await one();
        e.sms = { ...(e.sms || {}), [t]: nowISO() };
        e.updated_at = nowISO();
        await saveEntrantRecord(store, e);
        return json({ ok: true, id: e.id, sms: e.sms });
      }
      case "set_note": {
        const e = await one();
        e.office_note = clean(body.note).slice(0, 1000);
        e.updated_at = nowISO();
        await saveEntrantRecord(store, e);
        return json({ ok: true, id: e.id });
      }
      case "disqualify": {
        const e = await one();
        e.disqualified = Boolean(body.value);
        e.updated_at = nowISO();
        await saveEntrantRecord(store, e);
        return json({ ok: true, id: e.id, disqualified: e.disqualified });
      }
      case "set_opt_out": {
        const e = await one();
        e.sms_opt_out = Boolean(body.value);
        e.updated_at = nowISO();
        await saveEntrantRecord(store, e);
        return json({ ok: true, id: e.id, sms_opt_out: e.sms_opt_out });
      }
      case "update": return await doUpdate(store, await one(), body.fields);
      case "resync_rotor": {
        const e = await one();
        e.rotor = await upsertGiveawayLead(rotorEntryPayload(e)).catch(() => ({ delivered: false }));
        if (e.coupon && e.coupon.claimed_at)
          await upsertGiveawayLead(rotorClaimPayload(e, e.coupon.claimed_at, e.coupon.by)).catch(() => null);
        e.updated_at = nowISO();
        await saveEntrantRecord(store, e);
        if (!e.rotor.delivered) return fail(502, "Rotor didn't accept it. Try again in a minute.");
        return json({ ok: true, id: e.id, rotor: e.rotor });
      }
      case "delete": {
        const e = await one();
        await deleteEntrant(store, e);
        return json({ ok: true, deleted: e.id });
      }
      case "delete_all":
        if (body.confirm !== "DELETE ALL") return fail(400, 'Type "DELETE ALL" to confirm.');
        return json({ ok: true, deleted_keys: await deleteEverything(store) });
      default:
        return fail(400, "Unknown action.");
    }
  } catch (err) {
    if (err.status === 404) return fail(404, "Entrant not found.");
    throw err;
  }
}

// The office edits one entrant: name, address, the coupon opt-in, the coupon
// claim and the office note. Rotor gets what can be ADDED (its tags only
// merge): opting in adds "Giveaway - Coupon Opt-In"; marking claimed adds the
// claim tags and "Send the quote!" notes. Undoing either here doesn't remove
// a tag in Rotor (the reply says so). Name and address edits stay here: an
// existing Rotor lead's own details are never overwritten.
async function doUpdate(store, e, f) {
  if (!f || typeof f !== "object") return fail(400, "Nothing to update.");
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  const notes = [];
  if (has("first_name")) {
    const v = clean(f.first_name).slice(0, CAPS.name);
    if (!v) return fail(400, "First name can't be empty.");
    e.first_name = v;
  }
  if (has("last_name")) e.last_name = clean(f.last_name).slice(0, CAPS.name);
  if (has("street") || has("city") || has("zip")) {
    const a = { ...(e.address || {}) };
    const street = has("street") ? clean(f.street).slice(0, CAPS.street) : a.street;
    const city = has("city") ? clean(f.city).slice(0, CAPS.city) : a.city;
    const zip = has("zip") ? clean(f.zip).slice(0, CAPS.zip) : a.zip;
    if (!street) return fail(400, "Street can't be empty.");
    const moved = street !== a.street || city !== a.city || zip !== a.zip;
    if (moved) {
      const next = { ...a, street, city, zip, lat: null, lng: null, verified: false };
      const hk = householdKey(next);
      if (hk && hk !== e.household) {
        const other = await idForHousehold(store, hk);
        if (other && other !== e.id) return fail(409, "Someone else already entered from that address.");
        if (e.household && (await idForHousehold(store, e.household)) === e.id)
          await store.delete(KEYS.household(e.household));
        await putJSON(store, KEYS.household(hk), { id: e.id });
      }
      e.household = hk || e.household;
      e.address = next;
      e.area = areaCheck(next);
    }
  }
  let rotorWrite = null;
  if (has("offers_opt_in")) {
    const v = Boolean(f.offers_opt_in);
    if (v && !e.offers_opt_in) rotorWrite = { phone: e.phone, tags: [TAGS.COUPON_OPTIN] };
    if (!v && e.offers_opt_in) notes.push('Remove the "Giveaway - Coupon Opt-In" tag in Rotor by hand.');
    e.offers_opt_in = v;
  }
  let claimWrite = null;
  if (has("coupon_claimed")) {
    const v = Boolean(f.coupon_claimed);
    const was = Boolean(e.coupon && e.coupon.claimed_at);
    if (v && !was) {
      const at = nowISO();
      e.coupon = { claimed_at: at, by: "office" };
      claimWrite = rotorClaimPayload(e, at, "marked by the office");
    }
    if (!v && was) {
      e.coupon = null;
      notes.push('Remove the "Giveaway - Coupon Claimed" tag in Rotor by hand.');
    }
  }
  if (has("office_note")) e.office_note = clean(f.office_note).slice(0, 1000);
  e.updated_at = nowISO();
  await saveEntrantRecord(store, e);
  let rotor_ok = true;
  for (const w of [rotorWrite, claimWrite]) {
    if (!w) continue;
    const r = await upsertGiveawayLead(w).catch(() => ({ delivered: false }));
    if (!r.delivered) { rotor_ok = false; notes.push("Rotor didn't take the change; use Send to Rotor again."); }
    else if (w === claimWrite) e.coupon.rotor = r;
  }
  if (claimWrite) await saveEntrantRecord(store, e);
  return json({ ok: true, id: e.id, rotor_ok, notes });
}

function describe(result, entrants, extra = {}) {
  const byId = new Map(entrants.map((e) => [e.id, e]));
  const name = (x) => (byId.get(x) ? fullName(byId.get(x).first_name, byId.get(x).last_name) : x);
  return [
    ...result.drawn.map((d) => ({ id: d.id, kind: "drawn", name: name(d.id), entries: d.entries,
                                  odds: `${d.entries} of ${d.ticket_pool}`, ...extra })),
    ...result.bonus.map((b) => ({ id: b.id, kind: "bonus", name: name(b.id), because_of: b.because_of,
                                  because_of_name: name(b.because_of), ...extra })),
  ];
}

async function doDraw(store, body) {
  if (await getDraw(store)) return fail(409, "The drawing has already been held. Undo it first to draw again.");
  if (isOpen() && body.early !== true)
    return fail(409, `Entries are still open until ${DATES.closes}.`);
  const entrants = await allEntrants(store);
  const counts = entryCounts(entrants);
  if (!counts.size) return fail(409, "There are no eligible entrants yet.");
  const result = draw(entrants);
  const record = {
    drawn_at: nowISO(),
    eligible_entrants: counts.size,
    total_entries: [...counts.values()].reduce((s, c) => s + c, 0),
    winners: describe(result, entrants),
    replaced: [],
  };
  await saveDraw(store, record);
  record.rotor_tagged = await tagWinners(entrants, record.winners);
  return json({ ok: true, draw: record });
}

// Adds "Giveaway - Winner" to each winner's Rotor lead, so the coupon texts
// (3, 4, 5) can leave them out. Best-effort: the drawing never fails on it.
async function tagWinners(entrants, winners) {
  const byId = new Map(entrants.map((e) => [e.id, e]));
  let ok = 0;
  for (const w of winners) {
    const e = byId.get(w.id);
    if (!e) continue;
    // Tags only: Rotor merges tags, and nothing else on the lead changes.
    const r = await upsertGiveawayLead({
      phone: e.phone, tags: [TAGS.WINNER], name: fullName(e.first_name, e.last_name),
    }).catch(() => ({ delivered: false }));
    if (r.delivered) ok++;
  }
  return ok;
}

// Replace one drawn winner (didn't respond, ineligible) with an alternate.
// Their bonus winner, if any, goes too; the alternate can bring their own.
async function doRedraw(store, id) {
  const current = await getDraw(store);
  if (!current) return fail(409, "No drawing yet.");
  const target = current.winners.find((w) => w.id === id && w.kind === "drawn");
  if (!target) return fail(404, "That person isn't a drawn winner.");
  const entrants = await allEntrants(store);
  const out = current.winners.filter((w) => w.id === id || w.because_of === id);
  const keep = current.winners.filter((w) => !out.includes(w));
  const exclude = new Set([...current.winners.map((w) => w.id), ...current.replaced.map((w) => w.id)]);
  const result = draw(entrants, { n: 1, exclude });
  if (!result.drawn.length) return fail(409, "No one left to draw.");
  const record = {
    ...current,
    winners: [...keep, ...describe(result, entrants, { alternate: true })],
    replaced: [...current.replaced, ...out.map((w) => ({ ...w, replaced_at: nowISO() }))],
  };
  await saveDraw(store, record);
  record.rotor_tagged = await tagWinners(entrants, describe(result, entrants, { alternate: true }));
  return json({ ok: true, draw: record });
}

async function sendBatch(store, body) {
  const template = clean(body.template);
  if (!BROADCASTS.includes(template)) return fail(400, "Unknown text.");
  if (!twilioReady())
    return fail(409, "Automatic texting isn't set up (Twilio). Use the CSV export or the per-person text links.");
  const [entrants, drawResult] = await Promise.all([allEntrants(store), getDraw(store)]);
  if (template !== "nudge" && !drawResult) return fail(409, "Hold the drawing first.");
  const counts = entryCounts(entrants);
  const audience = broadcastAudience(template, entrants, drawResult);
  const limit = Math.max(1, Math.min(MAX_BATCH, Number(body.limit) || MAX_BATCH));
  const batch = audience.slice(0, limit);
  let sent = 0, failed = 0;
  for (const e of batch) {
    const ok = await sendSms(e164(e.phone), renderText(template, e, counts)).catch(() => false);
    e.sms = { ...(e.sms || {}), [ok ? template : `${template}_failed`]: nowISO() };
    if (ok) sent++; else failed++;
    // A failed send is recorded and skipped next time, so a bad number can't
    // stall the broadcast; the dashboard flags it for a hand-send.
    e.updated_at = nowISO();
    await saveEntrantRecord(store, e);
  }
  const remaining = audience.length - batch.length;
  return json({ ok: true, template, sent, failed, remaining });
}

export { eligible };
