// Work module, field part: what the people on a visit do there (design
// §5.5 "Field endpoints", §9.3 Visit field actions, §2.5 offline replays).
//
// Every route here is scoped to the visit's assignees, whatever their role
// (Alex and Jacob work their own visits with the same buttons): someone not
// on the visit gets 409 (the office: "add yourself first") or 404 (a
// technician; ids can't be probed), and a technician only inside the
// [today − 7, today + 30] window (§4.6). Answers to a technician carry the
// visit's techFields only.
//
//   POST  /visits/:id/on-my-way {eta_min, lat?, lng?}       text on_my_way (needs signal: never replayed),
//                                                            with the tracking link (track.mjs) when it's on
//   POST  /visits/:id/running-late {eta_min}                 text running_late (needs signal)
//   POST  /visits/:id/timer {action: start|pause|finish}     segments; start clocks in when clocked out
//   GET   /visits/:id/field                                  the visit's segments (who is working, minutes)
//                                                            and the last visit's notes at the place
//   PATCH /visits/:id/checklist {key, done, value?}          one item (done_at, done_by, value)
//   POST  /visits/:id/notes {text}                           added to the visit's notes
//   POST  /visits/:id/photos {data, thumb?, tag, item?}      a photo as base64 JSON, so it waits in the
//                                                            phone's outbox in order with everything else
//   GET   /visits/:id/pricebook                              what can be added on site (no prices without visits:prices)
//   POST  /visits/:id/lines {price_item_id, qty}             an upsell line on the job, credited to this person
//   POST  /visits/:id/complete {signature_file_id?}          finish: the required items gate it; every
//                                                            assignee's running timer stops
//   POST  /visits/:id/no-access {note}                       no access (the owners decide on the late-cancel fee)
//   POST  /visits/:id/incident {text, photo_ids?}            an incident task (barta-rules §8)
//   POST  /clock {action: in|out, category?}                 the person's shift; clocking out pauses their timers
//
// Offline replays carry client_id, queued_offline, queued_at and client_at
// and are replaySafe. A client id makes a repeat one change. A replayed
// time goes through judgeTime() (timesheets.mjs). A replayed change the
// visit no longer allows (the office cancelled it, someone else finished
// it) is never forced over what happened: it becomes an entry pending the
// office's decision (202 { pending_entry_id }). The same for:
//   - a replay for a visit the person lost meanwhile (given to someone
//     else, moved out of the window, deleted): the entry keeps what the
//     phone said (a note's text, a photo held on the entry) and the answer
//     carries nothing of the visit (reason lost);
//   - a replay done on another day than the visit's (the office moved it):
//     time, completion, ticks and lines wait (reason moved); notes and
//     photos go in and the office hears (applied);
//   - ticks, notes and photos on a visit the office cancelled: they go in,
//     and the office hears (reason cancelled, applied);
//   - a timer a phone ran while another of the person's ran on the visit
//     (two phones): reason overlap, as for shifts (timesheets.mjs).
//
// Photos: the bytes go through core/files.mjs (type from the magic bytes,
// never the header) and are stored exactly as the phone sent them: the app
// keeps the photo's EXIF (location included) on purpose (owner's rule).
// Visit photos are readable by the office and by a technician on the visit
// in the window, and editable by the visit's people and the office
// (defineFileOwner("visit")).

import { getRecord, getRecords, createRecord, updateRecord, readIndex, getSetting } from "../../../crm-store.mjs";
import { now, nowMs, nowIso, localDate, addLocalDays } from "../../core/clock.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { InputError, NotFoundError, ConflictError, ForbiddenError, ExistsError } from "../../core/errors.mjs";
import { techView, TECH_WINDOW } from "../../core/perms.mjs";
import { call as callService, has as hasService } from "../../core/services.mjs";
import { defineFileOwner, uploadFile, uploadThumb, fileView, sniffType, INLINE_TYPES, MAX_THUMB_BYTES } from "../../core/files.mjs";
import { automationDef, settingsFor, readAutomationsCfg } from "../../core/automations.mjs";
import { quietRule, allowedNow } from "../../core/send.mjs";
import { logAutomation } from "../../core/activity.mjs";
import { approvers } from "../../core/notify.mjs";
import { DEFAULT_CALENDAR } from "../../core/clock.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { checklistMissing, OPEN_VISIT } from "./states.mjs";
import { changeVisit, W, refreshVisits } from "./office.mjs";
import { timeOf, clientIdOf, clockIn, clockOut, ensureClockedIn, conflictEntry, payloadOf, userRecord } from "./timesheets.mjs";
import { runningTimer, visitTimers, startSegment, stopSegment, stopRunning, recomputeMinutes } from "./timers.mjs";
import { lastNotes } from "./techday.mjs";
import { trackLinkFor, TRACK_TEMPLATE } from "./track.mjs";

export const MAX_PHOTO_BYTES = 3000000;          // a photo sent as JSON (base64 ≈ 4 MB), under Netlify's 6 MB request cap
export const PHOTO_MAX_BODY = 4700000;
const PHOTO_TAGS = ["before", "after", "issue", "other"];
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const str = (v) => (v == null ? "" : String(v)).trim();
const isOffice = (ctx) => ctx.can("schedule:read");                 // unscoped: owners and the office
const replayed = (ctx) => !!(ctx.body && ctx.body.queued_offline === true);
const visitOut = (ctx, v) => (isOffice(ctx) ? view(v) : techView("visit", v));
const firstName = (u) => (u && (u.first_name || String(u.name || "").split(/\s+/)[0])) || "";

function inWindow(v) {
  const today = localDate(now());
  return v.date >= addLocalDays(today, -TECH_WINDOW.before) && v.date <= addLocalDays(today, TECH_WINDOW.after);
}

// A replay for a visit the person can't reach any more (see the top).
class LostVisit extends Error {
  constructor(visit) { super("That visit isn't there."); this.visit = visit; }
}

// The visit, for one of its people (see the top). → { visit, etag }
export async function fieldVisit(ctx, perm = "visits:work") {
  const id = ctx.params.id;
  if (!isId(id, "visit")) throw new NotFoundError("That visit isn't there.");
  const got = await getRecord("visit", id);
  if (!got) throw new NotFoundError("That visit isn't there.");
  const v = got.data;
  const office = isOffice(ctx);
  const on = !!ctx.user && (v.assignee_ids || []).includes(ctx.user.id);
  // work a phone did with no signal on a visit since deleted, moved out of reach or given to someone else
  if (replayed(ctx) && ctx.user && (v.deleted_at || !on || (!office && !inWindow(v)))) throw new LostVisit(v);
  if (v.deleted_at) throw new NotFoundError("That visit isn't there.");
  if (!office && !inWindow(v)) throw new NotFoundError("That visit isn't there.");
  if (!on) {
    if (office) throw new ConflictError("You're not on this visit. Add yourself on the schedule first.");
    throw new NotFoundError("That visit isn't there.");
  }
  if (!ctx.can(perm, { type: "visit", record: v })) throw new ForbiddenError("You don't have access to that.");
  return { visit: v, etag: got.etag };
}

// Field writes carry the phone's client id: a repeat (a double tap, an
// offline replay of something that landed) is then one change.
function needClientId(b) {
  const cid = clientIdOf(b);
  if (!cid) throw new InputError("This change needs its client id.", "client_id");
  return cid;
}

function geoOf(b) {
  const lat = Number(b && b.lat), lng = Number(b && b.lng);
  if (b && b.lat !== undefined && b.lat !== null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return [lat, lng];
  return undefined;
}

const MESSAGES = {
  conflict: "This change couldn't be applied as it was. The office will look at it.",
  lost: "You're not on this visit any more. The office has what you sent.",
  moved: "This visit was moved to another day. The office will look at what you sent.",
  cancelled: "This visit was cancelled. It's saved, and the office will look at it.",
  overlap: "Another timer or shift of yours covers that time. The office will look at it.",
  queued_mismatch: "The office will check this time.", too_old: "The office will check this time.", future: "The office will check this time.",
  no_device_time: "The office will check this time.", clock_skew: "This phone's clock is off. The office will check this time.", locked_period: "That week is already paid. The office will look at it.",
  stale: "This was more than a week old. The office has it.",
};
const pendingOut = (entry, reason, extra = {}) => ({ status: 202, data: { pending_entry_id: entry.id, pending: true, reason, message: MESSAGES[reason] || MESSAGES.conflict, ...extra } });

// An entry for the office (timesheets.mjs conflictEntry) about this request.
function entryFor(ctx, visit, action, { reason = "conflict", message, time, applied = false, extra, item } = {}) {
  return conflictEntry({
    user: ctx.user, visit, visitId: visit && visit.id, action, message, time: time || timeOf(ctx), clientId: clientIdOf(ctx.body), reason,
    payload: payloadOf(action, ctx.body || {}), applied, lost: reason === "lost", extra, item,
  }, W(ctx));
}

// The visit, or the answer for a replay that can't reach it any more:
// what the phone sent is kept on an entry and nothing of the visit goes back.
async function reach(ctx, action, perm = "visits:work") {
  try {
    return await fieldVisit(ctx, perm);
  } catch (e) {
    if (!(e instanceof LostVisit)) throw e;
    const entry = await entryFor(ctx, e.visit, action, { reason: "lost", message: e.visit.deleted_at ? "The visit was deleted." : "They weren't on this visit any more." });
    return { answer: pendingOut(entry, "lost") };
  }
}

// A replay done on another local day than the visit's date (the office moved it).
const movedAway = (ctx, visit, time) => replayed(ctx) && localDate(new Date(time.at)) !== visit.date;
const movedNote = (visit, time) => `Done on ${localDate(new Date(time.at))}; the visit is now on ${visit.date}.`;
// A tick, note or photo that goes in but the office should see: on a
// cancelled visit, or (notes and photos) one moved to another day.
async function appliedNote(ctx, visit, action, time) {
  if (!replayed(ctx)) return null;
  if (visit.status === "cancelled") return entryFor(ctx, visit, action, { reason: "cancelled", message: "The visit was cancelled.", time, applied: true });
  if (movedAway(ctx, visit, time)) return entryFor(ctx, visit, action, { reason: "moved", message: movedNote(visit, time), time, applied: true });
  return null;
}

// A replayed change the visit no longer allows → a pending entry (§2.5).
const CONFLICT_FIELDS = new Set(["transition", "checklist"]);
async function guarded(ctx, visit, action, time, fn, { item } = {}) {
  try {
    return await fn();
  } catch (e) {
    const conflict = e instanceof ConflictError || (e instanceof InputError && CONFLICT_FIELDS.has(e.field));
    if (!replayed(ctx) || !conflict) throw e;
    const latest = (await getRecord("visit", visit.id).catch(() => null)) || { data: visit };
    const entry = await entryFor(ctx, latest.data, action, { message: e.message, time, item });
    return pendingOut(entry, "conflict");
  }
}

const answer = async (ctx, visitId, extra = {}) => {
  const g = await getRecord("visit", visitId);
  return { data: { visit: g ? visitOut(ctx, g.data) : null, ...extra } };
};
const timerOut = (t) => (t ? techView("timer", t) : null);
const sheetOut = (s) => (s ? techView("timesheet", s) : null);

// ------------------------------------------------------------ texts: on my way, running late (§5.7.4)

const TEXTS = {
  "visit.on_my_way": "on_my_way",
  "visit.running_late": "running_late",
};

// A person's text to the visit's customer, now or never (a late "on my
// way" is worse than none): outside quiet hours it is blocked, not
// scheduled. → { status, mode?, reason?, outbox_id?, hand? }
async function visitText(ctx, visit, key, eta, clientId, { link } = {}) {
  const def = automationDef(key);
  const cfg = await readAutomationsCfg();
  const settings = def ? settingsFor(def, cfg) : { enabled: true, template_keys: [TEXTS[key]] };
  // the tracking link (work/track.mjs): the built-in text gets the version with the link;
  // a template the owner picked instead gets the link as {{portal_link}}
  const picked = (settings.template_keys || [])[0] || TEXTS[key];
  const template = link && picked === TEXTS[key] ? TRACK_TEMPLATE : picked;
  if (cfg.paused || settings.enabled === false) return { status: "off", reason: cfg.paused ? "paused" : "turned_off" };
  const [messaging, calendar] = await Promise.all([getSetting("messaging").catch(() => ({})), getSetting("calendar").catch(() => DEFAULT_CALENDAR)]);
  if (!allowedNow(quietRule("service", "user", (messaging && messaging.quiet) || {}, calendar || DEFAULT_CALENDAR))) {
    await logAutomation({ key, subject: visit.id, result: "skipped:quiet_hours" }).catch(() => {});
    return { status: "blocked", reason: "quiet_hours" };
  }
  const user = await userRecord(ctx.user.id).catch(() => null);
  const msg = {
    contact_id: visit.contact_id, channel: "sms", template_key: template, category: "service",
    vars: { tech_first_name: firstName(user || ctx.user) || "Your tech", eta_minutes: String(eta), ...(link ? { portal_link: link.url } : {}) },
    related: { visit_id: visit.id, job_id: visit.job_id }, origin: { kind: "user", user_id: ctx.user.id },
    marker_key: `${key === "visit.on_my_way" ? "omw" : "late"}-${clientId || ctx.requestId}`,
  };
  let out;
  try {
    const sysMode = await ctx.sysMode();
    out = await callService("messages.sink", msg, { ...ctx.write(), deploy: ctx.deploy, sysMode });
  } catch (e) {
    console.error(`crm:work: ${key} text failed (${safeErr(e)})`);
    return { status: "failed", reason: (e && e.message) || "not sent" };
  }
  await logAutomation({ key, subject: visit.id, result: out.status === "dry_run" ? "dry_run" : out.status === "blocked" ? `skipped:${out.blocked_reason}` : out.status }).catch(() => {});
  const res = { status: out.status, mode: out.mode, ...(out.blocked_reason ? { reason: out.blocked_reason } : {}), ...(out.outbox_id ? { outbox_id: out.outbox_id } : {}) };
  // texts aren't switched on yet: the words, so the tech can send them by hand
  if (out.mode === "dry_run" && out.outbox_id) {
    const ob = await getRecord("outbox", out.outbox_id).catch(() => null);
    const c = await getRecord("contact", visit.contact_id).catch(() => null);
    const phone = c && (c.data.phones || []).find((p) => p && p.e164 && p.sms !== false);
    if (ob && typeof ob.data.body === "string" && phone) {
      const footer = ((messaging && messaging.footer && messaging.footer.text) || " Reply STOP to opt out.").trim();
      const body = ob.data.footer_appended && ob.data.body.endsWith(footer) ? ob.data.body.slice(0, -footer.length).trim() : ob.data.body;
      res.hand = { to: phone.e164, body };
    }
  }
  return res;
}

function etaOf(b) {
  const n = Number(b && b.eta_min);
  if (!Number.isInteger(n) || n < 1 || n > 240) throw new InputError("Say about how many minutes (1 to 240).", "eta_min");
  return n;
}

const onMyWay = async (ctx) => {
  if (replayed(ctx)) throw new ConflictError("On my way needs signal. Nothing was sent.");
  const { visit } = await fieldVisit(ctx);
  const b = ctx.body || {};
  const eta = etaOf(b);
  const cid = clientIdOf(b);
  const again = !!(cid && visit.on_my_way && visit.on_my_way.client_id === cid);
  if (again && visit.on_my_way.text) return answer(ctx, visit.id, { text: visit.on_my_way.text, replay: true });
  const at = again ? visit.on_my_way.at : nowIso();
  const geo = geoOf(b);
  const r = again ? { visit } : await changeVisit(visit.id, "on_my_way", { ctx: W(ctx), mutate: (n) => ({ ...n, on_my_way: { at, by: ctx.user.id, eta_min: eta, ...(cid ? { client_id: cid } : {}), ...(geo ? { geo } : {}) } }) });
  // the customer's "on the way" page (work/track.mjs): the same tap makes the same link
  const link = await trackLinkFor({ visit: r.visit, userId: ctx.user.id, at, tapKey: cid || at });
  // a repeat whose text never went (a crash in between) sends it now; the send's marker keeps it to one
  const text = await visitText(ctx, r.visit, "visit.on_my_way", again ? visit.on_my_way.eta_min : eta, cid, { link });
  await updateRecord("visit", visit.id, (v) => (!v.on_my_way || v.on_my_way.at !== at ? null : { ...v, on_my_way: { ...v.on_my_way, text: { status: text.status, ...(text.reason ? { reason: text.reason } : {}) }, ...(text.outbox_id ? { message_id: text.outbox_id } : {}), ...(link ? { track: true } : {}) } }), W(ctx)).catch(() => {});
  return answer(ctx, visit.id, { text, ...(link ? { track_url: link.url } : {}) });
};

const runningLate = async (ctx) => {
  if (replayed(ctx)) throw new ConflictError("Running late needs signal. Nothing was sent.");
  const { visit } = await fieldVisit(ctx);
  const b = ctx.body || {};
  const eta = etaOf(b);
  const cid = clientIdOf(b);
  const had = (visit.running_late || []).find((x) => cid && x.client_id === cid);
  if (had && had.text) return answer(ctx, visit.id, { text: had.text, replay: true });
  const at = had ? had.at : nowIso();
  const r = had ? { visit } : await changeVisit(visit.id, "running_late", { ctx: W(ctx), mutate: (n) => ({ ...n, running_late: [...(n.running_late || []), { at, by: ctx.user.id, eta_min: eta, ...(cid ? { client_id: cid } : {}) }].slice(-20) }) });
  const text = await visitText(ctx, r.visit, "visit.running_late", had ? had.eta_min : eta, cid);
  await updateRecord("visit", visit.id, (v) => {
    const list = (v.running_late || []).map((x) => (x.at === at && x.by === ctx.user.id ? { ...x, text: { status: text.status, ...(text.reason ? { reason: text.reason } : {}) }, ...(text.outbox_id ? { message_id: text.outbox_id } : {}) } : x));
    return JSON.stringify(list) === JSON.stringify(v.running_late || []) ? null : { ...v, running_late: list };
  }, W(ctx)).catch(() => {});
  return answer(ctx, visit.id, { text });
};

// ------------------------------------------------------------ timers and completing

async function startWork(ctx, visit, time, b) {
  const uid = ctx.user.id;
  const cid = clientIdOf(b);
  const w = W(ctx);
  if (cid) {
    const had = await getRecord("timer", deriveId("timer", `c:${cid}`));
    if (had) return answer(ctx, visit.id, { timer: timerOut(had.data), replay: true });
  }
  if (time.source === "device") {
    // a replay over a timer of this person's that ran on the visit meanwhile (another phone): the office decides
    const t = nowMs();
    const startMs = Date.parse(time.at);
    const over = (await visitTimers(visit.id)).filter((x) => (x.user_ids || []).includes(uid) && (x.end_at ? Date.parse(x.end_at) : t) > startMs);
    if (over.length) {
      const entry = await entryFor(ctx, visit, "timer_start", { reason: "overlap", message: "Another timer of theirs ran on this visit then.", time, extra: { timer: { start: time.at }, with: over.map((x) => x.id).slice(0, 4) } });
      return pendingOut(entry, "overlap");
    }
  }
  const running = await runningTimer(visit.id, uid);
  if (running) return answer(ctx, visit.id, { timer: timerOut(running), already: true });
  if (["scheduled", "en_route", "paused"].includes(visit.status)) {
    try {
      await changeVisit(visit.id, "start", { ctx: w });
    } catch (e) {
      // someone else on the visit started it a moment ago: join them
      const cur = await getRecord("visit", visit.id);
      if (!(cur && cur.data.status === "in_progress")) throw e;
    }
  } else if (visit.status !== "in_progress") {
    throw new ConflictError(visit.status === "completed" ? "This visit is done." : "This visit is closed.");
  }
  const user = (await userRecord(uid)) || ctx.user;
  const clock = await ensureClockedIn(user, time, cid, w, { visitId: visit.id });
  const seg = await startSegment({ visit, userId: uid, time, clientId: cid, geo: geoOf(b) }, w);
  return answer(ctx, visit.id, { timer: timerOut(seg.timer), clock: { open: clock.pending ? null : sheetOut(clock.sheet), clocked_in: !!clock.created, ...(clock.pending ? { pending_entry_id: clock.sheet.id } : {}) } });
}

// A replayed pause names the segment it stops (timer_client_id: the
// client id of the start the phone made). When that isn't the running one:
// the end of the phone's own segment, kept on its overlap entry, or a
// disagreement for the office. → an answer, or null (pause the running one)
async function pauseOther(ctx, visit, time, b) {
  const uid = ctx.user.id;
  const tcid = clientIdOf({ client_id: b.timer_client_id });
  if (time.source !== "device" || !tcid) return null;
  const g = await getRecord("timer", deriveId("timer", `c:${tcid}`));
  const t = g && !g.data.deleted_at && (g.data.user_ids || []).includes(uid) ? g.data : null;
  if (t && !t.end_at) return null;                                     // the phone's own segment runs: stop it
  if (t && t.end_client_id && t.end_client_id === clientIdOf(b)) return answer(ctx, visit.id, { timer: timerOut(t), replay: true });
  const eg = await getRecord("timesheet", deriveId("timesheet", `c:${tcid}`, "conflict"));
  if (eg && eg.data.user_id === uid && eg.data.pending && eg.data.pending.timer) {
    const r = await updateRecord("timesheet", eg.data.id, (x) => (x.pending && x.pending.timer && !x.pending.timer.end ? { ...x, pending: { ...x.pending, timer: { ...x.pending.timer, end: time.at } } } : null), W(ctx));
    return pendingOut(r.data, "overlap");
  }
  if (t) {
    const entry = await entryFor(ctx, visit, "timer_pause", { reason: "conflict", message: "That timer was already stopped.", time });
    return pendingOut(entry, "conflict");
  }
  return null;
}

async function pauseWork(ctx, visit, time, b) {
  const uid = ctx.user.id;
  const cid = clientIdOf(b);
  const w = W(ctx);
  const other = await pauseOther(ctx, visit, time, b);
  if (other) return other;
  const running = await runningTimer(visit.id, uid);
  if (!running) {
    const list = cid ? await visitTimers(visit.id) : [];
    const done = list.find((t) => t.end_client_id === cid);
    if (done) {
      // finish what a crash may have left: nobody's timer runs, so the visit is paused
      if (visit.status === "in_progress" && !list.some((t) => !t.end_at)) await changeVisit(visit.id, "pause", { ctx: w });
      return answer(ctx, visit.id, { timer: timerOut(done), replay: true });
    }
    throw new ConflictError("Your timer isn't running.");
  }
  const seg = await stopSegment(running, { at: time.at, geo: geoOf(b), clientId: cid, untrusted: !time.trusted }, w);
  const others = (await visitTimers(visit.id)).filter((t) => !t.end_at);
  const cur = (await getRecord("visit", visit.id)).data;
  if (!others.length && cur.status === "in_progress") await changeVisit(visit.id, "pause", { ctx: w });
  await recomputeMinutes(visit.id, w);
  return answer(ctx, visit.id, { timer: timerOut(seg) });
}

// finish (from the timer or Complete): the required items gate it; the
// visit closes at the person's time; every assignee's running timer stops.
async function completeWork(ctx, visit, time, b) {
  const uid = ctx.user.id;
  const cid = clientIdOf(b);
  const w = W(ctx);
  if (visit.status === "completed") {
    // a double tap, a replay, or someone else on the visit finished it first
    // (a timer a crash left running stops at the completion too)
    const at = (visit.completion && visit.completion.at) || time.at;
    const left = await stopRunning(visit.id, { at }, w);
    if (left.length) await recomputeMinutes(visit.id, w);
    return answer(ctx, visit.id, { already: true });
  }
  const missing = checklistMissing(visit);
  if (missing.length) throw new InputError(`Finish the checklist first: ${missing.join(", ")}.`, "checklist");
  const sig = isId(b.signature_file_id, "file") ? b.signature_file_id : undefined;
  if (["scheduled", "en_route"].includes(visit.status)) {
    // done without the timer: under way, then done
    try { await changeVisit(visit.id, "start", { ctx: w }); } catch (e) {
      const cur = await getRecord("visit", visit.id);
      if (!(cur && ["in_progress", "paused"].includes(cur.data.status))) throw e;
    }
  }
  const completion = { at: time.at, by: uid, ...(cid ? { client_id: cid } : {}), ...(sig ? { signature_file_id: sig } : {}), ...(time.trusted ? {} : { unverified: true }) };
  try {
    await changeVisit(visit.id, "finish", { ctx: w, mutate: (n) => ({ ...n, completion }) });
  } catch (e) {
    // someone else on the visit finished it a moment ago: the same answer as a second tap
    const cur = e instanceof InputError && e.field === "transition" ? await getRecord("visit", visit.id) : null;
    if (cur && cur.data.status === "completed") return answer(ctx, visit.id, { already: true });
    throw e;
  }
  const stopped = await stopRunning(visit.id, { at: time.at, untrusted: !time.trusted }, w);
  await recomputeMinutes(visit.id, w);
  return answer(ctx, visit.id, { stopped: stopped.length });
}

// Time, completion and no access done on another day than the visit's
// (the office moved it meanwhile) wait for the office. → an answer or null
async function movedWait(ctx, visit, action, time) {
  if (!movedAway(ctx, visit, time)) return null;
  const entry = await entryFor(ctx, visit, action, { reason: "moved", message: movedNote(visit, time), time });
  return pendingOut(entry, "moved");
}

const timerRoute = async (ctx) => {
  const b = ctx.body || {};
  const action = b.action;
  if (!["start", "pause", "finish"].includes(action)) throw new InputError("Start, pause or finish?", "action");
  needClientId(b);
  const fv = await reach(ctx, `timer_${action}`);
  if (fv.answer) return fv.answer;
  const { visit } = fv;
  const time = timeOf(ctx);
  const moved = await movedWait(ctx, visit, `timer_${action}`, time);
  if (moved) return moved;
  return guarded(ctx, visit, action, time, () => (action === "start" ? startWork(ctx, visit, time, b) : action === "pause" ? pauseWork(ctx, visit, time, b) : completeWork(ctx, visit, time, b)));
};

const completeRoute = async (ctx) => {
  const b = ctx.body || {};
  needClientId(b);
  const fv = await reach(ctx, "complete");
  if (fv.answer) return fv.answer;
  const { visit } = fv;
  const time = timeOf(ctx);
  const moved = await movedWait(ctx, visit, "complete", time);
  if (moved) return moved;
  return guarded(ctx, visit, "complete", time, () => completeWork(ctx, visit, time, b));
};

const noAccess = async (ctx) => {
  const b = ctx.body || {};
  needClientId(b);
  const fv = await reach(ctx, "no_access");
  if (fv.answer) return fv.answer;
  const { visit } = fv;
  const time = timeOf(ctx);
  if (visit.status === "no_access") return answer(ctx, visit.id, { already: true });
  const moved = await movedWait(ctx, visit, "no_access", time);
  if (moved) return moved;
  const note = str(b.note).slice(0, 500);
  return guarded(ctx, visit, "no_access", time, async () => {
    await changeVisit(visit.id, "no_access", { ctx: W(ctx), note: note || undefined });
    return answer(ctx, visit.id);
  });
};

// GET /visits/:id/field: what the field panel needs beside the visit: its
// segments (whose timer runs, minutes so far) and the last visit's notes at
// the place; the phone keeps a copy for no signal.
const fieldRoute = async (ctx) => {
  const { visit } = await fieldVisit(ctx);
  const [list, notes] = await Promise.all([visitTimers(visit.id), lastNotes(visit, new Map()).catch(() => null)]);
  return { data: { timers: list.map(timerOut), mine: timerOut(list.find((t) => !t.end_at && (t.user_ids || []).includes(ctx.user.id)) || null), minutes_worked: visit.minutes_worked || 0, last_notes: notes } };
};

// ------------------------------------------------------------ the checklist, notes, photos

const ITEM_DONE = (i) => !!(i && (i.done_at || (i.value !== undefined && i.value !== null && i.value !== "")));

const checklistRoute = async (ctx) => {
  const b = ctx.body || {};
  const key = str(b.key);
  if (!key) throw new InputError("Which item?", "key");
  if (typeof b.done !== "boolean") throw new InputError("Done or not?", "done");
  const fv = await reach(ctx, "checklist");
  if (fv.answer) return fv.answer;
  const { visit } = fv;
  const item = ((visit.checklist && visit.checklist.items) || []).find((i) => i.key === key);
  if (!item) throw new InputError("That item isn't on this visit's checklist.", "key");
  let value;
  if (b.done && item.kind === "count") {
    const n = Number(b.value);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new InputError("Use a whole number.", "value");
    value = n;
  } else if (b.done && item.kind === "text") {
    value = str(b.value).slice(0, 500);
    if (!value) throw new InputError("Write it down first.", "value");
  } else if (b.done && item.kind === "photo") {
    throw new InputError("Take the photo for this one.", "key");
  }
  const time = timeOf(ctx);
  const closed = !OPEN_VISIT.includes(visit.status);
  if (closed && !replayed(ctx)) throw new ConflictError("This visit is closed.");
  // a tick from the day before the office moved the visit belongs to that day, not the new one
  const moved = await movedWait(ctx, visit, "checklist", time);
  if (moved) return moved;
  const uid = ctx.user.id;
  await updateRecord("visit", visit.id, (v) => {
    if (!OPEN_VISIT.includes(v.status) && !b.done) return null;           // never undo an item on a closed visit
    const items = ((v.checklist && v.checklist.items) || []).map((i) => {
      if (i.key !== key) return i;
      if (!b.done) { const { done_at, done_by, value: _v, done: _d, ...rest } = i; return rest; }
      if (ITEM_DONE(i) && (value === undefined || i.value === value)) return i;
      return { ...i, done_at: i.done_at && value === undefined ? i.done_at : time.at, done_by: uid, ...(value !== undefined ? { value } : {}) };
    });
    const next = { ...v, checklist: { ...(v.checklist || {}), items } };
    return JSON.stringify(next.checklist) === JSON.stringify(v.checklist) ? null : next;
  }, W(ctx));
  const note = await appliedNote(ctx, visit, "checklist", time);
  return answer(ctx, visit.id, note ? { pending_entry_id: note.id, noted: note.pending.reason } : {});
};

const notesRoute = async (ctx) => {
  const b = ctx.body || {};
  const text = str(b.text);
  if (!text) throw new InputError("Write the note.", "text");
  if (text.length > 1000) throw new InputError("Keep a note under 1,000 characters.", "text");
  const cid = needClientId(b);
  const fv = await reach(ctx, "notes");
  if (fv.answer) return fv.answer;
  const { visit } = fv;
  const time = timeOf(ctx);
  // a note that doesn't fit any more is kept on an entry (guarded), never dropped
  return guarded(ctx, visit, "notes", time, async () => {
    await updateRecord("visit", visit.id, (v) => {
      if (cid && (v.note_ids || []).includes(cid)) return null;
      const notes = v.tech_notes ? `${v.tech_notes}\n\n${text}` : text;
      if (notes.length > 4000) throw new ConflictError("This visit's notes are full. Ask the office to tidy them.");
      return { ...v, tech_notes: notes, ...(cid ? { note_ids: [...(v.note_ids || []), cid].slice(-50) } : {}) };
    }, W(ctx));
    const note = await appliedNote(ctx, visit, "notes", time);
    return answer(ctx, visit.id, note ? { pending_entry_id: note.id, noted: note.pending.reason } : {});
  });
};

// A file on the visit. A photo (JPEG, PNG, WebP) goes on its photos (and
// on its checklist item, when given); anything else (a PDF the office
// attaches) is an attachment: never a photo, never shown to the customer.
// Idempotent: the same file never shows twice, an item already done keeps
// its time.
export async function addPhoto(visitId, file, { item, by, at } = {}, w) {
  const tag = PHOTO_TAGS.includes(file.tag) ? file.tag : "other";
  const image = INLINE_TYPES.has(file.content_type) && !file.download_only;
  const r = await updateRecord("visit", visitId, (v) => {
    if (!image) {
      const list = v.attachments || [];
      if (list.some((a) => a.file_id === file.id)) return null;
      if (list.length >= 50) throw new ConflictError("This visit has as many files as it can hold.");
      return { ...v, attachments: [...list, { file_id: file.id, content_type: file.content_type, at: at || nowIso(), by, ...(file.caption ? { caption: file.caption } : {}) }] };
    }
    const photos = v.photos || [];
    const has = photos.some((p) => p.file_id === file.id);
    let items = (v.checklist && v.checklist.items) || [];
    let ticked = false;
    if (item) {
      items = items.map((i) => {
        if (i.key !== item || i.kind !== "photo" || ITEM_DONE(i)) return i;
        ticked = true;
        return { ...i, done_at: at || nowIso(), done_by: by, value: file.id };
      });
    }
    if (has && !ticked) return null;
    if (!has && photos.length >= 200) throw new ConflictError("This visit has as many photos as it can hold.");
    return {
      ...v,
      photos: has ? photos : [...photos, { file_id: file.id, tag, customer_visible: tag === "before" || tag === "after", at: at || nowIso(), by, ...(file.caption ? { caption: file.caption } : {}), ...(item ? { item } : {}) }],
      ...(ticked ? { checklist: { ...(v.checklist || {}), items } } : {}),
    };
  }, w);
  return r.data;
}

function b64(s, field, max) {
  if (typeof s !== "string" || !s) throw new InputError("Attach the photo.", field);
  const clean = s.replace(/^data:[a-z/+.-]+;base64,/i, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(clean)) throw new InputError("That photo didn't come through.", field);
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (!bytes.length) throw new InputError("That photo is empty.", field);
  if (bytes.length > max) throw new InputError("That photo is too big.", field);
  return bytes;
}

// A photo kept on an entry for the office instead of the visit: one of a
// week-old queue (hold: true; the office reads it with the queue on
// Approvals), or one for a visit the person can't reach any more. Its
// bytes are never lost; the answer carries nothing of the visit.
async function holdPhoto(ctx, visit, reason, { bytes, thumb, tag, time }) {
  const message = reason === "stale" ? "Taken more than six days before it came in." : visit && visit.deleted_at ? "The visit was deleted." : "They weren't on this visit any more.";
  const entry = await entryFor(ctx, visit, "photo", { reason, message, time });
  const file = await uploadFile(ctx, { ownerType: "timesheet", ownerId: entry.id, kind: "photo", tag, declaredType: "image/jpeg", bytes, clientId: clientIdOf(ctx.body), takenAt: time.at });
  if (thumb && !file.has_thumb) await uploadThumb(ctx, file.id, thumb).catch((e) => console.error(`crm:work: thumbnail not kept (${safeErr(e)})`));
  return pendingOut(entry, reason, { file_id: file.id });
}

const photoRoute = async (ctx) => {
  const b = ctx.body || {};
  const tag = PHOTO_TAGS.includes(b.tag) ? b.tag : "other";
  const cid = clientIdOf(b);
  if (!cid) throw new InputError("A photo needs its client id.", "client_id");
  const bytes = b64(b.data, "data", MAX_PHOTO_BYTES);
  // a visit photo is a picture (the type from its magic bytes, core/files.mjs): a PDF or anything else isn't one
  if (!INLINE_TYPES.has(sniffType(bytes))) throw new InputError("That isn't a photo. Take it with the camera.", "data");
  const thumb = b.thumb ? b64(b.thumb, "thumb", MAX_THUMB_BYTES) : null;
  const time = timeOf(ctx);
  if (replayed(ctx) && b.hold === true) {
    if (!isId(ctx.params.id, "visit")) throw new NotFoundError("That visit isn't there.");
    const g = await getRecord("visit", ctx.params.id);
    const v = g ? g.data : null;
    const mine = !!(v && !v.deleted_at && (v.assignee_ids || []).includes(ctx.user.id) && (isOffice(ctx) || inWindow(v)));
    return holdPhoto(ctx, mine ? v : null, "stale", { bytes, thumb, tag, time });
  }
  let visit;
  try {
    ({ visit } = await fieldVisit(ctx));
  } catch (e) {
    if (!(e instanceof LostVisit)) throw e;
    return holdPhoto(ctx, e.visit, "lost", { bytes, thumb, tag, time });
  }
  const item = str(b.item) || undefined;
  if (item && !((visit.checklist && visit.checklist.items) || []).some((i) => i.key === item)) throw new InputError("That item isn't on this visit's checklist.", "item");
  const caption = str(b.caption).slice(0, 200) || undefined;
  // the bytes as they came: the type from the magic bytes (core/files.mjs)
  const file = await uploadFile(ctx, { ownerType: "visit", ownerId: visit.id, kind: "photo", tag, caption, declaredType: "image/jpeg", bytes, clientId: cid, takenAt: time.at });
  let f = file;
  if (thumb && !file.has_thumb) f = await uploadThumb(ctx, file.id, thumb).catch((e) => { console.error(`crm:work: thumbnail not kept (${safeErr(e)})`); return file; });
  // a photo from the day before the office moved the visit doesn't tick the new day's item
  await addPhoto(visit.id, f, { item: movedAway(ctx, visit, time) ? undefined : item, by: ctx.user.id, at: time.at }, W(ctx));
  const note = await appliedNote(ctx, visit, "photo", time);
  const out = fileView(f);
  return { status: 201, ...(await answer(ctx, visit.id, { photo: { id: out.id, tag, has_thumb: !!out.has_thumb, url: out.url, thumb_url: out.thumb_url || null }, ...(note ? { pending_entry_id: note.id, noted: note.pending.reason } : {}) })) };
};

// Who may read and add a visit's files (core/files.mjs): the office, and a
// technician on the visit inside the window.
defineFileOwner("visit", {
  canRead: (ctx, v) => ctx.can("schedule:read") || (ctx.can("schedule:read", { type: "visit", record: v }) && inWindow(v)),
  canEdit: (ctx, v) => ctx.can("schedule:write") || (!!ctx.user && (v.assignee_ids || []).includes(ctx.user.id) && ctx.can("visits:work", { type: "visit", record: v }) && inWindow(v)),
  async attach(visit, file, ctx) {
    const item = (ctx.body && typeof ctx.body.item === "string" && ctx.body.item) || (ctx.query && ctx.query.get && ctx.query.get("item")) || undefined;
    await addPhoto(visit.id, file, { item, by: ctx.user ? ctx.user.id : "office", at: file.taken_at || nowIso() }, ctx.write ? ctx.write() : W(ctx));
  },
});

// Files an entry holds (a photo kept for the office, above): the office
// reads them on Timesheets; the person who sent it sees it on their own.
defineFileOwner("timesheet", {
  canRead: (ctx, s) => ctx.can("time:edit_others") || (!!ctx.user && s.user_id === ctx.user.id),
  canEdit: (ctx, s) => !!ctx.user && s.user_id === ctx.user.id && s.status === "pending_approval",
  async attach(sheet, file, ctx) {
    await updateRecord("timesheet", sheet.id, (x) => {
      const ids = (x.pending && x.pending.file_ids) || [];
      return ids.includes(file.id) ? null : { ...x, pending: { ...(x.pending || {}), file_ids: [...ids, file.id].slice(0, 10) } };
    }, ctx.write ? ctx.write() : W(ctx));
  },
});

// ------------------------------------------------------------ upsell lines (D11)

const pricebookRoute = async (ctx) => {
  const { visit } = await fieldVisit(ctx, "visits:add_line");
  const prices = ctx.can("visits:prices", { type: "visit", record: visit });
  const ix = await readIndex("pricebook", "").catch(() => ({ rows: [] }));
  const items = ix.rows.filter((r) => r.act !== false && r.sell !== false && Number.isFinite(r.uc) && r.uc > 0)
    .sort((a, b) => String(a.cat).localeCompare(String(b.cat)) || String(a.nm).localeCompare(String(b.nm)))
    .map((r) => ({ id: r.id, name: r.nm, category: r.cat, unit: r.u, service_type: r.st, ...(prices ? { unit_cents: r.uc } : {}) }));
  return { data: { items, prices } };
};

const lineOut = (ctx, visit, job, lineId) => {
  const prices = ctx.can("visits:prices", { type: "visit", record: visit });
  const line = (job.lines || []).find((l) => l.id === lineId);
  const out = line ? { id: line.id, title: line.title, qty_milli: line.qty_milli, ...(prices ? { unit_cents: line.unit_cents, total_cents: line.total_cents } : {}) } : null;
  return { line: out, ...(prices ? { totals: job.totals } : {}) };
};

const linesRoute = async (ctx) => {
  const b = ctx.body || {};
  if (!isId(b.price_item_id, "price_item")) throw new InputError("Pick what you added.", "price_item_id");
  const qty = Number(b.qty ?? 1);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1000) throw new InputError("Use a quantity from 1 to 1,000.", "qty");
  const qtyMilli = Math.round(qty * 1000);
  if (qtyMilli < 1) throw new InputError("Use a quantity from 1 to 1,000.", "qty");
  const cid = needClientId(b);
  const fv = await reach(ctx, "lines", "visits:add_line");
  if (fv.answer) return fv.answer;
  const { visit } = fv;
  const time = timeOf(ctx);
  const lineId = `up_${deriveId("event", `line:${cid}`).slice(3, 15)}`;
  const jg = await getRecord("job", visit.job_id);
  if (!jg || jg.data.deleted_at) throw new NotFoundError("That visit's job isn't there.");
  // a repeat of a line that went in
  if ((jg.data.lines || []).some((l) => l.id === lineId)) return { status: 200, data: lineOut(ctx, visit, jg.data, lineId) };
  const moved = await movedWait(ctx, visit, "lines", time);
  if (moved) return moved;
  // an upsell queued offline that no longer fits (the job closed, the item went) waits for the office (guarded)
  return guarded(ctx, visit, "lines", time, async () => {
    const pi = await getRecord("price_item", b.price_item_id);
    if (!pi || pi.data.deleted_at || pi.data.active === false || pi.data.sellable === false) {
      if (replayed(ctx)) throw new ConflictError("That item isn't in the price book any more.");
      throw new InputError("That isn't in the price book.", "price_item_id");
    }
    if (!OPEN_VISIT.includes(visit.status)) throw new ConflictError("This visit is closed. Ask the office to add it.");
    if (!["unscheduled", "scheduled", "in_progress"].includes(jg.data.status)) throw new ConflictError("This job is closed. Ask the office to add it.");
    const at = nowIso();
    const r = await updateRecord("job", visit.job_id, (j) => {
      if ((j.lines || []).some((l) => l.id === lineId)) return null;
      if (!["unscheduled", "scheduled", "in_progress"].includes(j.status)) throw new ConflictError("This job is closed. Ask the office to add it.");
      if ((j.lines || []).length >= 60) throw new ConflictError("This job has as many lines as it can hold.");
      const it = pi.data;
      return {
        ...j,
        lines: [...(j.lines || []), {
          id: lineId, price_item_id: it.id, title: it.name, qty_milli: qtyMilli, unit_cents: it.unit_cents || 0, service_type: it.service_type, scope: { type: "all" },
          upsell_user_id: ctx.user.id, upsell: { by: ctx.user.id, at, visit_id: visit.id },
        }],
      };
    }, W(ctx));
    // what the job's visits copy (its services) follows; a no-op when it already does (a retry after a crash)
    await refreshVisits(visit.job_id, ctx).catch((e) => console.error(`crm:work: visits not refreshed (${safeErr(e)})`));
    return { status: r.changed ? 201 : 200, data: lineOut(ctx, visit, r.data, lineId) };
  });
};

// ------------------------------------------------------------ incidents (barta-rules §8)

const incidentRoute = async (ctx) => {
  const b = ctx.body || {};
  const text = str(b.text);
  if (!text) throw new InputError("Say what happened.", "text");
  if (text.length > 2000) throw new InputError("Keep it under 2,000 characters.", "text");
  const photos = Array.isArray(b.photo_ids) ? b.photo_ids.filter((x) => isId(x, "file")).slice(0, 10) : [];
  const cid = needClientId(b);
  let visit;
  try {
    ({ visit } = await fieldVisit(ctx, "incidents:create"));
  } catch (e) {
    // an incident is never lost: one sent for a visit the person lost meanwhile still reaches the owners
    if (!(e instanceof LostVisit)) throw e;
    visit = e.visit;
  }
  const id = deriveId("task", `c:${cid}`);
  const had = await getRecord("task", id);
  if (had) return { data: { task_id: id, replay: true } };
  const owners = await approvers().catch(() => []);
  const title = `Incident: ${text.split(/\n/)[0]}`.slice(0, 160);
  try {
    await createRecord("task", {
      id, title, kind: "incident", priority: "high", status: "open", contact_id: visit.contact_id, contact_name: visit.contact_name || undefined, job_id: visit.job_id, visit_id: visit.id,
      assignee_ids: owners.slice(0, 3), notes: text, reported_by: ctx.user.id, ...(photos.length ? { photo_ids: photos } : {}),
    }, W(ctx));
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
  }
  return { status: 201, data: { task_id: id } };
};

// ------------------------------------------------------------ clock in / out

const clockRoute = async (ctx) => {
  const b = ctx.body || {};
  const action = b.action;
  if (!["in", "out"].includes(action)) throw new InputError("Clock in or out?", "action");
  const time = timeOf(ctx);
  const cid = needClientId(b);
  const user = (await userRecord(ctx.user.id)) || ctx.user;
  const w = W(ctx);
  const geo = geoOf(b);
  if (action === "in") {
    const category = b.category === undefined ? "service" : b.category;
    const r = await clockIn(user, { category, time, clientId: cid, geo }, w);
    // a replay over another shift of theirs (two phones): it waits for the office
    if (r.pending) return pendingOut(r.sheet, "overlap", { open: null });
    return { status: r.created ? 201 : 200, data: { open: sheetOut(r.sheet), already: !!r.already, ...(r.closed_forgotten ? { closed_forgotten: sheetOut(r.closed_forgotten) } : {}) } };
  }
  const r = await clockOut(user, { time, clientId: cid, geo, shiftClientId: clientIdOf({ client_id: b.shift_client_id }) }, w);
  if (r.none || r.disagree) {
    if (!replayed(ctx)) throw new ConflictError("You're not clocked in.");
    // a clock-out with no shift to close, or not the one open (§2.5 conflicts): for the office
    // (the phone's own shift already closed, by the app at its deadline say: the office sets the right end)
    const why = r.none ? "conflict" : r.why === "closed" ? "conflict" : "overlap";
    const entry = await conflictEntry({ user, action: "clock_out", message: r.none ? "There was no open shift to close." : r.why === "closed" ? "That shift was already closed." : "It didn't match the shift that was open.", time, clientId: cid, reason: why }, w);
    return pendingOut(entry, why, { closed: null, open: null });
  }
  // the phone's own shift that waits for the office (it overlapped another, or its times weren't taken): its end is kept on the entry
  if (r.pending) return pendingOut(r.sheet, (r.sheet.pending && r.sheet.pending.reason) || "overlap", { closed: sheetOut(r.sheet), open: null });
  // the work stops with the shift: this person's running timers pause (a replay finishes what a crash left);
  // never for the end of another phone's earlier shift, which isn't the work going on now
  let paused = 0;
  if ((r.closed || r.replay) && !r.other && !(r.sheet && r.sheet.flags || []).includes("overlap_cleared")) {
    const ix = await readIndex("timers", "active").catch(() => ({ rows: [] }));
    for (const row of ix.rows.filter((x) => (x.u || []).includes(user.id) && x.v)) {
      const t = await runningTimer(row.v, user.id);
      if (!t) continue;
      await stopSegment(t, { at: r.sheet.end_at || time.at, untrusted: !time.trusted }, w);
      const vg = await getRecord("visit", row.v);
      const still = (await visitTimers(row.v)).filter((x) => !x.end_at);
      if (vg && vg.data.status === "in_progress" && !still.length) await changeVisit(row.v, "pause", { ctx: w }).catch((e) => console.error(`crm:work: visit not paused (${safeErr(e)})`));
      await recomputeMinutes(row.v, w);
      paused += 1;
    }
  }
  return { data: { closed: sheetOut(r.sheet), open: null, replay: !!r.replay, paused } };
};

// ------------------------------------------------------------ the table

const R = (method, path, perm, handler, extra = {}) => ({ method, path, auth: "session", perm, subject: "required", mode: "inline", handler, replaySafe: true, ...extra });

export const fieldVisitRoutes = [
  R("POST", "/visits/:id/on-my-way", "visits:work", onMyWay, { maxCalls: 80, replaySafe: false }),
  R("POST", "/visits/:id/running-late", "visits:work", runningLate, { maxCalls: 80, replaySafe: false }),
  R("POST", "/visits/:id/timer", "visits:work", timerRoute, { maxCalls: 120 }),
  R("GET", "/visits/:id/field", "visits:work", fieldRoute, { maxCalls: 60, replaySafe: false }),
  R("PATCH", "/visits/:id/checklist", "visits:work", checklistRoute, { maxCalls: 40 }),
  R("POST", "/visits/:id/notes", "visits:work", notesRoute, { maxCalls: 40 }),
  R("POST", "/visits/:id/photos", "visits:work", photoRoute, { maxCalls: 60, maxBody: PHOTO_MAX_BODY }),
  R("GET", "/visits/:id/pricebook", "visits:add_line", pricebookRoute, { maxCalls: 30, replaySafe: false }),
  R("POST", "/visits/:id/lines", "visits:add_line", linesRoute, { maxCalls: 80 }),
  R("POST", "/visits/:id/complete", "visits:work", completeRoute, { maxCalls: 120 }),
  R("POST", "/visits/:id/no-access", "visits:work", noAccess, { maxCalls: 80 }),
  R("POST", "/visits/:id/incident", "incidents:create", incidentRoute, { maxCalls: 40 }),
  R("POST", "/clock", "time:own", clockRoute, { subject: "none", maxCalls: 120 }),
];

export { hasService };
