// Comms: in-app star ratings (Rotor's Reviews, the Rotor guide's K6 to K8
// and S27 with §7.4's changes; owner defaults Q3 and Q7).
//
// - A rating (rt_) is what a customer tapped on the review page
//   (/p/review/:id, a portal link scoped to the job, or to the contact when
//   there is no job): 1 to 5 stars and a comment. One per link: a second
//   tap changes it. The crew comes from the job's people.
// - The Google link shows at EVERY rating by default (Q3: Google's rules
//   don't allow asking only happy customers; cfg/reviews.link_from_stars
//   can raise it), and a tap on it is recorded (public_clicked). A rating
//   of 3 or less also makes a "Review needs a follow-up" task for the
//   owners (when the sales module is there).
// - Manual ratings (Flyra's "Add review": a call, a card) are source
//   "manual".
// - It is built but OFF until the switch (Q7): cfg/reviews.ratings = false
//   keeps the review texts on the Google link; turned on, the review
//   sequence's {{review_link}} is this page instead. The texts themselves
//   follow the send rule (a dry run until texting is live).
//
//   GET  /ratings?f=needs_follow_up|public&source=app|manual   rows (newest first) + tiles, the
//                                                 star spread and a leaderboard by crew (this month)
//   POST /ratings                                 { contact_id?, name?, stars, comment? }   a manual one
//   POST /ratings/:id/followed-up                 the owners called them back
//   POST /ratings/link                            { contact_id, job_id? } → the review page's link (office)

import { createRecord, updateRecord, getRecord, readIndex, getSetting, ExistsError } from "../../../crm-store.mjs";
import { isId, deriveId } from "../../core/ids.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError } from "../../core/errors.mjs";
import { truncate } from "../../core/text.mjs";
import { call, has } from "../../core/services.mjs";
import { approvers } from "../../core/notify.mjs";
import { createPortalLink } from "../../portal/core.mjs";
import { REVIEWS_DEFAULTS } from "./reviews.mjs";
import { safeErr } from "../../../referral-lib.mjs";

import { RATING_SOURCES, LOW_STARS, ratingRow, ratingType } from "./types.mjs";
export { RATING_SOURCES, LOW_STARS, ratingRow, ratingType };

// cfg/reviews additions: ratings on or off (off until the switch), and from how many stars the Google link shows (1: always).
export const RATINGS_DEFAULTS = Object.freeze({ ratings: false, link_from_stars: 1 });
export function cleanRatingSettings(o = {}) {
  const from = o.link_from_stars === undefined || o.link_from_stars === null ? 1 : o.link_from_stars;
  if (!Number.isInteger(from) || from < 1 || from > 5) throw new InputError("From 1 to 5 stars.", "link_from_stars");
  if (o.ratings !== undefined && typeof o.ratings !== "boolean") throw new InputError("On or off.", "ratings");
  return { ratings: o.ratings === true, link_from_stars: from };
}
const settings = async () => ({ ...REVIEWS_DEFAULTS, ...RATINGS_DEFAULTS, ...((await getSetting("reviews").catch(() => null)) || {}) });

const nameOf = (c) => (c ? [c.first_name, c.last_name ? `${String(c.last_name).slice(0, 1)}.` : ""].filter(Boolean).join(" ") || c.display_name || "" : "");

// The review page's link for a customer (and their job): a portal link scoped to it.
export async function reviewLink({ contact_id, job_id = null, created_by = "system" }) {
  if (!isId(contact_id, "contact")) throw new InputError("Pick the customer.", "contact_id");
  const link = await createPortalLink({ contact_id, scope: { kind: "review", id: job_id || contact_id }, created_by });
  return { code: link.code, url: link.url };
}

// One rating per review page (its scope id): a second tap changes the stars.
export const ratingIdFor = (contactId, scopeId) => deriveId("rating", contactId, `rating.${scopeId}`, 1);

export async function rate({ contact_id, scope_id, stars, comment }, ctx) {
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new InputError("Tap one to five stars.", "stars");
  const text = comment === undefined || comment === null ? "" : String(comment).trim().slice(0, 1000);
  const cfg = await settings();
  const contact = await getRecord("contact", contact_id).catch(() => null);
  let job = null;
  if (isId(scope_id, "job")) { const g = await getRecord("job", scope_id).catch(() => null); if (g && g.data.contact_id === contact_id) job = g.data; }
  const id = ratingIdFor(contact_id, scope_id);
  const crew = job ? [...new Set((job.assignee_ids || []).filter((x) => isId(x, "user")))].slice(0, 10) : [];
  const data = { contact_id, ...(job ? { job_id: job.id } : {}), name: nameOf(contact && contact.data), stars: n, ...(text ? { comment: text } : {}), crew_ids: crew, source: "app", rated_at: nowIso() };
  let rec;
  try { rec = (await createRecord("rating", { id, ...data, public_clicked: false }, ctx)).data; } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    rec = (await updateRecord("rating", id, (r) => ({ ...r, ...data, ...(text ? {} : { comment: r.comment }) }), ctx)).data;
  }
  if (n <= LOW_STARS && !(rec.follow_up && rec.follow_up.task_id)) rec = await followUpTask(rec, contact && contact.data, ctx);
  return { rating: rec, show_google: n >= cfg.link_from_stars, google_link: cfg.link };
}

// A low rating: the owners call them back (a task, when the sales module is there).
async function followUpTask(rec, contact, ctx) {
  if (!has("sales.createTask")) return rec;
  try {
    const owners = await approvers().catch(() => []);
    const task = await call("sales.createTask", {
      title: `Review needs a follow-up: ${rec.stars} star${rec.stars === 1 ? "" : "s"}`, kind: "follow_up", priority: "high", status: "open",
      contact_id: rec.contact_id, assignee_ids: owners.slice(0, 5), due_at: nowIso(), notes: rec.comment ? truncate(rec.comment, 400) : "",
    }, { seed: `rating-${rec.id}` }, ctx);
    if (task && task.id) return (await updateRecord("rating", rec.id, (r) => ({ ...r, follow_up: { ...(r.follow_up || {}), task_id: task.id } }), ctx)).data;
  } catch (e) { console.error(`crm:ratings: the follow-up task was not made (${safeErr(e)})`); }
  return rec;
}

export async function clickedPublic(contact_id, scope_id, ctx) {
  const id = ratingIdFor(contact_id, scope_id);
  const got = await getRecord("rating", id).catch(() => null);
  if (!got) return null;
  return (await updateRecord("rating", id, (r) => (r.public_clicked ? null : { ...r, public_clicked: true, public_clicked_at: nowIso() }), ctx)).data;
}

// ------------------------------------------------------------ the office's list

const monthOf = (iso) => localDate(new Date(Date.parse(iso || 0) || 0)).slice(0, 7);
export function ratingsView(rows, { f = null, source = null, month = localDate(now()).slice(0, 7) } = {}) {
  const all = rows.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const dist = [0, 0, 0, 0, 0];
  for (const r of all) if (r.s >= 1 && r.s <= 5) dist[r.s - 1] += 1;
  const sum = all.reduce((t, r) => t + (r.s || 0), 0);
  const crew = {};
  for (const r of all) if (monthOf(r.at) === month) for (const u of r.t || []) { const c = (crew[u] = crew[u] || { user_id: u, count: 0, stars: 0, five: 0 }); c.count += 1; c.stars += r.s; if (r.s === 5) c.five += 1; }
  const list = all.filter((r) => (!source || r.src === source) && (f === "needs_follow_up" ? r.fu : f === "public" ? r.pc : true));
  return {
    rows: list.slice(0, 200).map((r) => ({ id: r.id, contact_id: r.c, name: r.n, stars: r.s, at: r.at, job_id: r.j, crew_ids: r.t, source: r.src, public_clicked: r.pc, has_comment: r.cm, needs_follow_up: r.fu })),
    tiles: { all: all.length, needs_follow_up: all.filter((r) => r.fu).length, public: all.filter((r) => r.pc).length, avg: all.length ? Math.round((sum / all.length) * 10) / 10 : null, five_pct: all.length ? Math.round((dist[4] / all.length) * 100) : null },
    dist, leaderboard: Object.values(crew).map((c) => ({ ...c, avg: Math.round((c.stars / c.count) * 10) / 10 })).sort((a, b) => b.count - a.count || b.avg - a.avg),
  };
}

async function list(ctx) {
  const f = ctx.query.get("f") || null;
  if (f && !["needs_follow_up", "public"].includes(f)) throw new InputError("That filter isn't one of the choices.", "f");
  const source = ctx.query.get("source") || null;
  if (source && !RATING_SOURCES.includes(source)) throw new InputError("In the app or added by hand.", "source");
  const [ix, cfg] = await Promise.all([readIndex("ratings", ""), settings()]);
  return { data: ratingsView(ix.rows, { f, source }), meta: { ratings_on: cfg.ratings, link_from_stars: cfg.link_from_stars, google_link: cfg.link } };
}

async function one(ctx) {
  if (!isId(ctx.params.id, "rating")) throw new NotFoundError("That rating isn't there.");
  const got = await getRecord("rating", ctx.params.id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That rating isn't there.");
  return { data: got.data };
}

async function addManual(ctx) {
  const b = ctx.body || {};
  let contact = null;
  if (b.contact_id !== undefined && b.contact_id !== null && b.contact_id !== "") {
    if (!isId(b.contact_id, "contact")) throw new InputError("Pick the customer.", "contact_id");
    const g = await getRecord("contact", b.contact_id);
    if (!g || g.data.deleted_at) throw new InputError("That customer isn't there.", "contact_id");
    contact = g.data;
  }
  const name = String(b.name || nameOf(contact) || "").trim().slice(0, 80);
  if (!name) throw new InputError("Who left it?", "name");
  const rec = (await createRecord("rating", { ...(contact ? { contact_id: contact.id } : {}), name, stars: b.stars, ...(b.comment ? { comment: b.comment } : {}), crew_ids: [], source: "manual", public_clicked: false, rated_at: nowIso() }, ctx.write())).data;
  return { status: 201, data: rec };
}

async function followedUp(ctx) {
  if (!isId(ctx.params.id, "rating")) throw new NotFoundError("That rating isn't there.");
  const r = await updateRecord("rating", ctx.params.id, (x) => (x.follow_up && x.follow_up.done_at ? null : { ...x, follow_up: { ...(x.follow_up || {}), done_at: nowIso(), done_by: ctx.user.id } }), ctx.write());
  return { data: r.data };
}

async function linkRoute(ctx) {
  const b = ctx.body || {};
  if (b.job_id !== undefined && b.job_id !== null && !isId(b.job_id, "job")) throw new InputError("That isn't a job.", "job_id");
  return { data: await reviewLink({ contact_id: b.contact_id, job_id: b.job_id || null, created_by: ctx.user.id }) };
}

const r = (method, path, perm, subject, handler, more = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...more });
export const ratingRoutes = [
  r("GET", "/ratings", "reviews:read", "none", list, { maxCalls: 40 }),
  r("GET", "/ratings/:id", "reviews:match", "required", one),
  r("POST", "/ratings", "reviews:match", "none", addManual, { maxCalls: 30 }),
  r("POST", "/ratings/link", "reviews:match", "none", linkRoute, { maxCalls: 30 }),
  r("POST", "/ratings/:id/followed-up", "reviews:match", "required", followedUp, { maxCalls: 30 }),
];

// ------------------------------------------------------------ the customer's page

const STAR_WORDS = ["", "Poor", "Not great", "Okay", "Good", "Great"];
function pageBody(p, { done = null, company = {}, cfg }) {
  const e = p.esc;
  const stars = [1, 2, 3, 4, 5].map((n) => `<label class="rv-star"><input type="radio" name="stars" value="${n}"${done && done.stars === n ? " checked" : ""} required><span aria-hidden="true">★</span><span class="sr">${n} star${n === 1 ? "" : "s"}: ${STAR_WORDS[n]}</span></label>`).join("");
  const google = `<a class="btn block" data-google href="${e(cfg.link)}" rel="noopener" target="_blank">Post it on Google</a>`;
  return `<section class="card" data-review data-id="${e(p.params.id)}" data-from="${cfg.link_from_stars}">
    <h1>How did we do?</h1>
    <p class="muted">Tap the stars. Your words go straight to ${e(company.name || "Barta Window Washing")}.</p>
    <form data-review-f>
      <fieldset class="rv-stars"><legend class="sr">Stars</legend>${stars}</fieldset>
      <label class="field"><span>Anything to add? (optional)</span><textarea name="comment" rows="3" maxlength="1000">${done && done.comment ? e(done.comment) : ""}</textarea></label>
      <button class="btn block" type="submit">Send</button>
      <p class="err" data-error hidden></p>
    </form>
    <div data-thanks${done ? "" : " hidden"}>
      <h2>Thank you!</h2>
      <p data-low hidden>We're sorry it wasn't great. The owners will call you to make it right (our guarantee is a free re-clean).</p>
      <div data-public${done && done.stars >= cfg.link_from_stars ? "" : " hidden"}><p>It would mean a lot if you shared it on Google too. It helps neighbors find a local family business.</p>${google}</div>
    </div>
  </section>`;
}
const PAGE_CSS = `<style>.rv-stars{border:0;padding:0;margin:8px 0 14px;display:flex;justify-content:center;gap:4px}.rv-star{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:48px;min-height:48px;font-size:36px;color:#c8c8cf;cursor:pointer}.rv-star input{position:absolute;opacity:0;width:1px;height:1px}.rv-star.on{color:#f5a623}.rv-star input:focus-visible+span{outline:2px solid #fb4d3d;border-radius:6px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.field{display:block;margin:0 0 12px}.field span{display:block;font-size:14px;margin-bottom:6px}.field textarea{width:100%;font:inherit;font-size:16px;padding:10px;border-radius:10px;border:1px solid #d5d5db;box-sizing:border-box}</style>`;

async function reviewPage(p) {
  const cfg = await settings();
  const id = ratingIdFor(p.contact_id, p.params.id);
  const had = await getRecord("rating", id).catch(() => null);
  const body = pageBody(p, { done: had ? had.data : null, company: p.company, cfg });
  return p.portalPage(p.layout({ title: "How did we do?", body: PAGE_CSS + body, script: "comms-review.js", company: p.company, page: "review" }));
}

export const portalRoutes = [
  { method: "GET", path: "/p/review/:id", scope: "review", handler: reviewPage },
  {
    method: "POST", path: "/api/portal/review/:id", scope: "review",
    handler: async (p) => {
      try {
        const b = p.body || {};
        const out = await rate({ contact_id: p.contact_id, scope_id: p.params.id, stars: Number(b.stars), comment: b.comment }, p.write());
        return p.json({ ok: true, data: { stars: out.rating.stars, show_google: out.show_google, google_link: out.show_google ? out.google_link : null, low: out.rating.stars <= LOW_STARS } });
      } catch (e) {
        if (e instanceof InputError) return p.fail("input", e.message, 400);
        throw e;
      }
    },
  },
  {
    method: "POST", path: "/api/portal/review/:id/clicked", scope: "review",
    handler: async (p) => { await clickedPublic(p.contact_id, p.params.id, p.write()); return p.json({ ok: true, data: null }); },
  },
];

// The review texts' link while ratings are on (the review sequence): this page, else Google's.
export async function sequenceLink(contactId, jobId) {
  const cfg = await settings();
  if (!cfg.ratings) return null;
  try { return (await reviewLink({ contact_id: contactId, job_id: jobId })).url; } catch (e) { console.error(`crm:ratings: no review page link (${safeErr(e)})`); return null; }
}
