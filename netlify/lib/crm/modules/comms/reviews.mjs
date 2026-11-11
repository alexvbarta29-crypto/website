// Comms: Google reviews and the review sequence (design §5.7.6, §6.6,
// §5.7.4 review.sequence, D24, B3).
//
// Reviews are READ from Google Business Profile, never written: the CRM
// does not reply to a review and does not post (public words need a
// person's OK and stay with the existing connector).
//
// - reviews.poll (hourly, only when the reviews integration is live on the
//   production deploy with Google's keys): new reviews become review
//   records (ptr/gbp-review makes each land once) with suggested matches:
//   jobs completed in the 21 days before the review whose contact's name
//   fits the reviewer's display name (first name + last initial).
// - A match is a person's tap (names are fuzzy: never automatic):
//   POST /reviews/:id/match sets the contact's reviews stats
//   (review_left_at), which stops that contact's review sequence and feeds
//   reviews.isReviewed, credits the job's techs and emits review.matched.
// - review.sequence: when a job is completed (billable or lights; not a
//   touch-up, a callback or warranty work), three texts from the sender
//   the owner picked: step 1 90 minutes later (moved into 09:00-19:00),
//   step 2 on day 3 at 11:00, step 3 on day 8 at 11:00. All three are
//   queued at once; each is re-checked when it is due and skipped when the
//   customer replied, opted out, was matched to a review, or was asked in
//   the last 180 days. Before cutover every step is dry-run (the Outbox)
//   and imported jobs are never asked (they were completed before the floor).

import { createRecord, updateRecord, getRecord, readIndex, readPointer, getSetting, getRaw, putRaw, updateStats, addActivity, ExistsError } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, nowIso, nowMs, localDate, localTime, zonedToUtc, addLocalDays } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { adapter } from "../../adapters/index.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { reviewKey } from "./types.mjs";

export const REVIEWS_DEFAULTS = Object.freeze({ link: "https://g.page/r/CfnTsPliwEw4EBM/review", match_days: 21, ask_again_days: 180 });
export function validateReviews(v) {
  const o = v && typeof v === "object" ? v : {};
  const link = String(o.link || REVIEWS_DEFAULTS.link).trim();
  if (!/^https:\/\/[^\s]{4,200}$/.test(link)) throw new InputError("Use the https link to the review page.", "link");
  const num = (k, min, max) => { const n = o[k] === undefined ? REVIEWS_DEFAULTS[k] : o[k]; if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`Between ${min} and ${max}.`, k); return n; };
  return { link, match_days: num("match_days", 1, 90), ask_again_days: num("ask_again_days", 0, 730) };
}

const POLL_KEY = "sys/reviews-poll";
// (work/types.mjs JOB_KINDS: a touch-up, warranty work and a takedown are never a reason to ask)
const SKIP_KINDS = new Set(["touch_up", "warranty", "lights_warranty", "lights_takedown"]);

// ------------------------------------------------------------ matching

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").trim();
// 1 = same first name and last name (or last initial); 0.6 = same first name only; 0 = no.
export function nameScore(reviewer, contactName) {
  const a = norm(reviewer).split(/\s+/).filter(Boolean);
  const b = norm(contactName).split(/\s+/).filter(Boolean);
  if (!a.length || !b.length || a[0] !== b[0]) return 0;
  const la = a.length > 1 ? a[a.length - 1] : "";
  const lb = b.length > 1 ? b[b.length - 1] : "";
  if (la && lb && (la === lb || (la.length === 1 && lb.startsWith(la)) || (lb.length === 1 && la.startsWith(lb)))) return 1;
  return la && lb ? 0 : 0.6;
}

// Jobs completed in the `days` before the review whose contact's name fits. Pure over the jobs index rows.
export function suggestMatches(review, jobRows, { days = 21 } = {}) {
  const at = Date.parse(review.created_at_gbp || review.create_time || "") || 0;
  const out = [];
  for (const j of jobRows) {
    if (!j || !j.done || !j.c || SKIP_KINDS.has(j.k)) continue;
    const done = Date.parse(j.done);
    if (!at || done > at + 86400000 || done < at - days * 86400000) continue;
    const score = nameScore(review.reviewer_name || review.reviewer, j.cn);
    if (score > 0) out.push({ contact_id: j.c, job_id: j.id, score, name: j.cn, on: String(j.done).slice(0, 10) });
  }
  return out.sort((x, y) => y.score - x.score || String(y.on).localeCompare(String(x.on))).slice(0, 5);
}

async function recentJobRows() {
  const y = Number(localDate(now()).slice(0, 4));
  const [a, b] = await Promise.all([readIndex("jobs", String(y)).catch(() => ({ rows: [] })), readIndex("jobs", String(y - 1)).catch(() => ({ rows: [] }))]);
  return [...a.rows, ...b.rows];
}

// ------------------------------------------------------------ the poll

// Sweep reviews.poll: reads what Google has since the last poll. Read-only.
export async function pollReviews(ctx) {
  const a = await adapter("reviews", { deploy: ctx.deploy, mode: ctx.mode });
  if (a.mode !== "live" || !a.impl || typeof a.impl.listReviews !== "function") return { progress: 0, result: "skipped:not_connected" };
  const state = await getRaw(POLL_KEY).catch(() => null);
  const since = state && state.data ? state.data.since : null;
  let list;
  try { list = await a.impl.listReviews({ since }); } catch (e) {
    console.error(`crm:reviews: the poll failed (${safeErr(e)})`);
    return { progress: 0, result: "failed" };
  }
  if (!list.length) return { progress: 0 };
  const cfg = await getSetting("reviews").catch(() => REVIEWS_DEFAULTS);
  const jobs = await recentJobRows();
  let made = 0;
  let newest = since;
  for (const g of list.slice(0, 50)) {
    if (g.update_time && (!newest || g.update_time > newest)) newest = g.update_time;
    if (await readPointer("gbp-review", reviewKey(g.id))) continue;
    const review = { gbp_review_id: g.id, reviewer_name: g.reviewer, rating: g.rating, comment_excerpt: g.comment || "", created_at_gbp: g.create_time || g.update_time || nowIso() };
    try {
      await createRecord("review", { ...review, suggestions: suggestMatches(review, jobs, { days: cfg.match_days }) }, ctx.write());
      made += 1;
    } catch (e) { if (!(e instanceof ExistsError)) throw e; }
  }
  if (newest && newest !== since) await putRaw(POLL_KEY, { since: newest, at: nowIso() });
  if (made) await notify(await approvers().catch(() => []), { kind: "review", title: made === 1 ? "A new Google review" : `${made} new Google reviews`, body: "Match each to its customer.", link: "/reviews" }, ctx.write()).catch(() => {});
  return { progress: made };
}

export async function unmatchedReviews() {
  const ix = await readIndex("reviews", "");
  return ix.rows.filter((r) => !r.m && r.s > 0).length;
}

// ------------------------------------------------------------ a person's match

export async function matchReview(id, body, ctx) {
  if (!isId(id, "review")) throw new NotFoundError("That review isn't there.");
  const got = await getRecord("review", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That review isn't there.");
  const b = body || {};
  if (!isId(b.contact_id, "contact")) throw new InputError("Pick the customer.", "contact_id");
  const c = await getRecord("contact", b.contact_id);
  if (!c || c.data.deleted_at) throw new InputError("That customer isn't there.", "contact_id");
  let techs = [];
  let jobId = null;
  if (b.job_id) {
    if (!isId(b.job_id, "job")) throw new InputError("That isn't a job.", "job_id");
    const j = await getRecord("job", b.job_id).catch(() => null);
    if (!j || j.data.contact_id !== c.data.id) throw new InputError("That job isn't this customer's.", "job_id");
    jobId = j.data.id;
    techs = (j.data.assignee_ids || []).filter((x) => isId(x, "user")).slice(0, 10);
  }
  if (got.data.match && got.data.match.contact_id && got.data.match.contact_id !== c.data.id) throw new ConflictError("This review is already matched. Open the customer to change it.");
  const at = got.data.created_at_gbp || nowIso();
  const r = await updateRecord("review", id, (x) => ({ ...x, match: { contact_id: c.data.id, ...(jobId ? { job_id: jobId } : {}), tech_ids: techs, by: "confirmed", confirmed_by: ctx.user.id, at: nowIso() } }), ctx.write());
  // the contact's reviews stats: reviews.isReviewed, the "no review yet" audience, and the sequence's stop
  await updateStats(c.data.id, "reviews", (p) => ({ ...p, review_left_at: p.review_left_at || at, ...(p.sequence && !p.sequence.stopped ? { sequence: { ...p.sequence, stopped: "reviewed", stopped_at: nowIso() } } : {}) }), ctx.write());
  await addActivity(c.data.id, "review.matched", id, new Date(at)).catch(() => {});
  await emit("review.matched", { id, wv: r.data.wv, review_id: id, contact_id: c.data.id, tech_ids: techs }, ctx.write()).catch((e) => console.error(`crm:reviews: review.matched not emitted (${safeErr(e)})`));
  return r.data;
}

// The reviews.isReviewed service: a matched Google review on file.
export async function isReviewed(contactId) {
  if (!isId(contactId, "contact")) return false;
  const got = await getRecord("contact_stats", contactId).catch(() => null);
  return !!(got && got.data && got.data.reviews && got.data.reviews.review_left_at);
}

// ------------------------------------------------------------ the review sequence

// Step times (D24): 1 = completion + delay minutes, moved into 09:00-19:00 local; 2 and 3 = day 3 and day 8 at 11:00.
export function stepTimes(completedAt, delayMin = 90) {
  let t = new Date(Date.parse(completedAt) + delayMin * 60000);
  const hhmm = localTime(t);
  if (hhmm < "09:00") t = zonedToUtc(localDate(t), "09:00");
  else if (hhmm >= "19:00") t = zonedToUtc(addLocalDays(localDate(t), 1), "09:00");
  const day = localDate(new Date(completedAt));
  return [t, zonedToUtc(addLocalDays(day, 3), "11:00"), zonedToUtc(addLocalDays(day, 8), "11:00")];
}

const SERVICE_WORDS = { windows_ext: "window cleaning", windows_int: "window cleaning", windows: "window cleaning", screens: "screen cleaning", tracks: "track cleaning", gutters: "gutter cleaning", lights_install: "Christmas lights", lights: "Christmas lights" };
const serviceWords = (job) => {
  const words = [...new Set((job.service_types || []).map((s) => SERVICE_WORDS[String(s).toLowerCase()] || (/window/i.test(s) ? "window cleaning" : /gutter/i.test(s) ? "gutter cleaning" : /light/i.test(s) ? "Christmas lights" : null)).filter(Boolean))];
  return words.length ? words.slice(0, 2).join(" and ") : null;
};

export const reviewSequence = {
  key: "review.sequence", label: "Review requests", trigger: "event:job.completed", category: "service", imported: "no", mutates: false,
  defaults: { enabled: true, channels: ["sms"], template_keys: ["review_1", "review_2", "review_3"], delay: 90, max_per_contact_days: 180 },
  async run(input, actx) {
    const p = (input.event && input.event.payload) || {};
    if (!isId(p.job_id, "job") || !isId(p.contact_id, "contact")) return { result: "skipped:no_job" };
    const got = await getRecord("job", p.job_id).catch(() => null);
    const job = got ? got.data : null;
    if (!job || job.status !== "completed") { await actx.log(p.job_id, "skipped:changed"); return { result: "skipped:changed" }; }
    const lights = job.kind === "lights_install";
    if (SKIP_KINDS.has(job.kind) || (job.billable === false && !lights)) { await actx.log(job.id, "skipped:not_billable"); return { result: "skipped:not_billable" }; }
    const fact = { fact_at: job.completed_at || p.at, record: job };
    const e = actx.eligible(fact);
    if (!e.ok) { await actx.log(job.id, `skipped:${e.reason}`); return { result: `skipped:${e.reason}` }; }
    const st = await getRecord("contact_stats", job.contact_id).catch(() => null);
    const rv = (st && st.data && st.data.reviews) || {};
    if (rv.review_left_at) { await actx.log(job.id, "skipped:reviewed"); return { result: "skipped:reviewed" }; }
    const days = Number.isInteger(actx.settings.max_per_contact_days) ? actx.settings.max_per_contact_days : 180;
    if (rv.last_sequence_at && rv.sequence && rv.sequence.job_id !== job.id && nowMs() - Date.parse(rv.last_sequence_at) < days * 86400000) { await actx.log(job.id, "skipped:asked_recently"); return { result: "skipped:asked_recently" }; }
    const contact = await getRecord("contact", job.contact_id).catch(() => null);
    if (!contact) return { result: "skipped:no_contact" };
    const times = stepTimes(fact.fact_at || nowIso(), Number(actx.settings.delay) || 90);
    const keys = actx.settings.template_keys && actx.settings.template_keys.length ? actx.settings.template_keys : ["review_1", "review_2", "review_3"];
    const vars = { ...(serviceWords(job) ? { service_list: serviceWords(job) } : {}) };
    let queued = 0;
    for (let n = 1; n <= Math.min(3, keys.length); n++) {
      const r = await actx.send({ contact_id: job.contact_id, contact: contact.data, subject: { type: "job", id: job.id }, key: `${job.id}--${n}`, n, channel: "sms", template_key: keys[n - 1], due_at: times[n - 1], vars, related: { job_id: job.id }, ...fact });
      if (r.queued) queued += 1;
    }
    if (queued) await updateStats(job.contact_id, "reviews", (x) => ({ ...x, last_sequence_at: nowIso(), sequence: { job_id: job.id, started_at: nowIso(), steps: queued } }), actx.write()).catch((err) => console.error(`crm:reviews: the sequence was not noted (${safeErr(err)})`));
    return { result: queued ? `queued:${queued}` : "skipped:nothing" };
  },
  // when a step is due: not after a reply, an opt-out, a matched review or a reopened job
  async recheck(item) {
    const d = item.data || {};
    const st = await getRecord("contact_stats", d.contact_id).catch(() => null);
    const rv = (st && st.data && st.data.reviews) || {};
    if (rv.review_left_at) return { skip: "reviewed" };
    const jobId = d.related && d.related.job_id;
    if (rv.sequence && rv.sequence.job_id === jobId && rv.sequence.stopped) return { skip: rv.sequence.stopped };
    const cm = (st && st.data && st.data.comms) || {};
    if (rv.sequence && rv.sequence.job_id === jobId && cm.last_inbound_at && cm.last_inbound_at > rv.sequence.started_at) return { skip: "replied" };
    if (isId(jobId, "job")) { const j = await getRecord("job", jobId).catch(() => null); if (!j || j.data.status !== "completed") return { skip: "changed" }; }
    return {};
  },
};

// A reply or an opt-out stops the sequence (the steps left are skipped when due).
const stop = (why) => async (event, h) => {
  const p = event.payload || {};
  if (!isId(p.contact_id, "contact")) return { result: "skipped:no_contact" };
  if (why === "opted_out" && p.state !== "opted_out") return { result: "skipped:opted_in" };
  const st = await getRecord("contact_stats", p.contact_id).catch(() => null);
  const seq = st && st.data && st.data.reviews && st.data.reviews.sequence;
  if (!seq || seq.stopped) return { result: "skipped:no_sequence" };
  await updateStats(p.contact_id, "reviews", (x) => (x.sequence && !x.sequence.stopped ? { ...x, sequence: { ...x.sequence, stopped: why, stopped_at: nowIso() } } : null), h.ctx.write());
  return { result: `stopped:${why}` };
};
export const reviewListeners = {
  "message.inbound": { handler: stop("replied"), mutates: false },
  "consent.changed": { handler: stop("opted_out"), mutates: false },
};

// ------------------------------------------------------------ routes

async function list(ctx) {
  const ix = await readIndex("reviews", "");
  const rows = ix.rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 100);
  const weekAgo = nowMs() - 7 * 86400000;
  const perTech = {};
  for (const r of ix.rows) if (r.m && Date.parse(r.at || 0) >= weekAgo) for (const t of r.t || []) perTech[t] = (perTech[t] || 0) + 1;
  const a = await adapter("reviews", { deploy: ctx.deploy }).catch(() => ({ mode: "dry_run" }));
  return { data: rows.map((r) => ({ id: r.id, reviewer_name: r.n, rating: r.r, created_at_gbp: r.at, matched: !!r.m, contact_id: r.m || null, suggestions: r.s })), meta: { per_tech_week: perTech, mode: a.mode, goal_per_tech_week: 2 } };
}
async function one(ctx) {
  if (!isId(ctx.params.id, "review")) throw new NotFoundError("That review isn't there.");
  const got = await getRecord("review", ctx.params.id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That review isn't there.");
  const x = got.data;
  let matched = null;
  if (x.match && isId(x.match.contact_id, "contact")) { const c = await getRecord("contact", x.match.contact_id).catch(() => null); matched = { contact_id: x.match.contact_id, name: c ? c.data.display_name || "" : "", job_id: x.match.job_id || null, tech_ids: x.match.tech_ids || [] }; }
  return { data: { id: x.id, reviewer_name: x.reviewer_name, rating: x.rating, comment_excerpt: x.comment_excerpt || "", created_at_gbp: x.created_at_gbp || null, match: matched, suggestions: x.suggestions || [] }, etag: got.etag };
}
const match = async (ctx) => { const x = await matchReview(ctx.params.id, ctx.body, ctx); return { data: { id: x.id, match: x.match } }; };

const r = (method, path, perm, subject, handler, more = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...more });
export const reviewRoutes = [
  r("GET", "/reviews", "reviews:read", "none", list),
  r("GET", "/reviews/:id", "reviews:match", "required", one),
  r("POST", "/reviews/:id/match", "reviews:match", "required", match, { maxCalls: 40 }),
];
