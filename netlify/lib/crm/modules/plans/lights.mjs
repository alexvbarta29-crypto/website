// Plans module: Christmas lights seasons (design §5.4 "Christmas lights
// seasons", decisions D9, D30).
//
// One season of lights at one property is a season_install record
// (ptr/season/{property}--{season}): sold → install_scheduled → installed →
// takedown_scheduled → taken_down → stored (or cancelled). The lights op
// makes, at once and only once: the install job (kind lights_install, due
// before the season's install-by date), the takedown job (lights_takedown,
// unscheduled, due in January of the next year, a $0 "Takedown + storage
// (included)" line) and the season record. It runs when a lights plan's
// season comes (plans.make, plans.jobs_backfill, the rebook for 3-year
// contracts) and when a one-time lights install job appears (a quote
// converted "this season only": the quote.converted listener adds the takedown
// and the record). The pointer is the dedupe across all those paths.
//
// The season follows its jobs (listeners on job.*); the takedown done, the
// office enters the bin id (PATCH /lights/installs/:id) and the season is
// stored: property.lights gets the bin and the last season. In-season
// warranty fixes are $0 lights_warranty jobs linked to the season.

import { createRecord, getRecord, getRecords, updateRecord, readIndex, readPointer, claimPointer } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError, ParallelRunGuard } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { keySafe } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { seasonKey, LIGHT_COLORS } from "./types.mjs";
import { loadLights } from "./catalog.mjs";

export const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
const pad2 = (n) => String(n).padStart(2, "0");
const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");
const isTakedownLine = (l) => /takedown/i.test(String(l.title || ""));
const isWarrantyLine = (l) => l.category === "warranty" || /warranty/i.test(String(l.title || ""));

export const TAKEDOWN_LINE = Object.freeze({ id: "ln_takedown", title: "Takedown + storage (included)", qty_milli: 1000, unit_cents: 0, service_type: "Christmas Lights" });

// The install job's lines: the lights lines, without the $0 takedown and warranty lines (they have their own jobs).
export const installLines = (lines = []) => (lines || []).filter((l) => !(l.optional && l.selected !== true) && !isTakedownLine(l) && !isWarrantyLine(l)).map((l) => {
  const { selected, ...rest } = l;
  return { ...rest, optional: false, scope: { type: "all" } };
});

// Feet of lights from the per-foot install line (else 0).
export function footageOf(lines = []) {
  const ft = (lines || []).find((l) => l.unit === "ft" && /install/i.test(String(l.title || ""))) || (lines || []).find((l) => l.unit === "ft");
  return ft && Number.isSafeInteger(ft.qty_milli) ? Math.round(ft.qty_milli / 1000) : 0;
}
// Colors named in a lights line's description ("Colors: warm white, red").
export function colorsOf(lines = []) {
  const text = (lines || []).map((l) => String(l.description || "")).join(" ").toLowerCase();
  return LIGHT_COLORS.filter((c) => text.includes(c.replace("_", " ")));
}

// When an install is due: November of the season, or this month when the
// sale comes later (never after the install-by month).
export function installMonth(season, today, lights) {
  const by = `${season}-${String((lights && lights.install_by) || "12-15").slice(0, 2)}`;
  const nov = `${season}-11`;
  const cur = String(today).slice(0, 7);
  const m = cur > nov ? cur : nov;
  return m > by ? by : m;
}
export const takedownMonth = (season, lights) => `${season + 1}-${pad2((lights && lights.takedown_month) || 1)}`;

export async function seasonByPointer(key) {
  const p = await readPointer("season", key);
  if (!p || !isId(p.id, "season_install")) return null;
  const g = await getRecord("season_install", p.id);
  return g && !g.data.deleted_at ? g.data : null;
}

// The lights op (one season, one property). spec: { contact_id,
// property_id?, season, plan_id?, quote_id?, deal_id?, lines, discounts,
// install_job_id? (a job that exists already), early_bird?, three_year?,
// contract_season_n? }. → { season_id, install_job_id, takedown_job_id, created }
export async function createSeason(spec, opId, ctx) {
  const lights = await loadLights();
  const today = localDate(now());
  const c = await getRecord("contact", spec.contact_id);
  if (!c || c.data.deleted_at) throw new NotFoundError("That contact isn't there anymore.");
  const contact = c.data;
  const property_id = isId(spec.property_id, "property") ? spec.property_id : isId(contact.primary_property_id, "property") ? contact.primary_property_id : undefined;
  const key = seasonKey({ property_id, contact_id: contact.id, season: spec.season });
  const had = await seasonByPointer(key);
  if (had) return { season_id: had.id, install_job_id: had.install_job_id || null, takedown_job_id: had.takedown_job_id || null, created: false };
  const sid = deriveId("season_install", opId, "plans.lights", 1);
  const mine = await getRecord("season_install", sid);
  if (mine) return { season_id: sid, install_job_id: mine.data.install_job_id || null, takedown_job_id: mine.data.takedown_job_id || null, created: false };
  const lines = spec.lines || [];
  const specs = [];
  if (!isId(spec.install_job_id, "job")) {
    specs.push({
      contact_id: contact.id, ...(property_id ? { property_id } : {}), kind: "lights_install", title: `Christmas lights install ${spec.season}`, lines: installLines(lines),
      discounts: (spec.discounts || []).map((d) => ({ ...d, scope: { type: "all" } })), target_month: installMonth(spec.season, today, lights), season_install_id: sid,
      ...(spec.plan_id ? { plan_id: spec.plan_id, ...(spec.plan_ordinal ? { plan_ordinal: spec.plan_ordinal } : {}) } : {}),
      ...(spec.quote_id ? { quote_id: spec.quote_id } : {}), ...(spec.deal_id ? { deal_id: spec.deal_id } : {}), billable: true,
    });
  }
  specs.push({
    contact_id: contact.id, ...(property_id ? { property_id } : {}), kind: "lights_takedown", title: `Christmas lights takedown ${spec.season}`, lines: [{ ...TAKEDOWN_LINE }],
    discounts: [], target_month: takedownMonth(spec.season, lights), season_install_id: sid, ...(spec.plan_id ? { plan_id: spec.plan_id } : {}), billable: false,
  });
  let ids = [];
  if (has("work.createJobs")) ids = (await call("work.createJobs", specs, opId, "lights", W(ctx))) || [];
  const install_job_id = isId(spec.install_job_id, "job") ? spec.install_job_id : ids.length === 2 ? ids[0] : undefined;
  const takedown_job_id = ids.length ? ids[ids.length - 1] : undefined;
  let town;
  if (property_id) { const p = await getRecord("property", property_id); town = p && p.data.address ? p.data.address.city : undefined; }
  try {
    await createRecord("season_install", {
      id: sid, contact_id: contact.id, contact_name: nameOf(contact), ...(property_id ? { property_id } : {}), ...(town ? { town } : {}), season: spec.season,
      ...(spec.plan_id ? { plan_id: spec.plan_id } : {}), ...(spec.quote_id ? { quote_id: spec.quote_id } : {}), status: "sold",
      ...(install_job_id ? { install_job_id } : {}), ...(takedown_job_id ? { takedown_job_id } : {}), warranty_job_ids: [], footage_ft: Number.isSafeInteger(spec.footage_ft) ? spec.footage_ft : footageOf(lines),
      colors: Array.isArray(spec.colors) ? spec.colors.filter((x) => LIGHT_COLORS.includes(x)) : colorsOf(lines), design_file_ids: [],
      early_bird: !!spec.early_bird, three_year: !!spec.three_year, ...(spec.contract_season_n ? { contract_season_n: spec.contract_season_n } : {}),
    }, W(ctx));
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    // another path made this season first (the pointer): use it
    const other = await seasonByPointer(key) || ((await getRecord("season_install", sid)) || {}).data;
    if (!other) throw e;
    return { season_id: other.id, install_job_id: other.install_job_id || null, takedown_job_id: other.takedown_job_id || null, created: false };
  }
  return { season_id: sid, install_job_id: install_job_id || null, takedown_job_id: takedown_job_id || null, created: true };
}

// The season a job belongs to (its install or takedown), or null.
export async function seasonOfJob(job) {
  if (isId(job.season_install_id, "season_install")) {
    const g = await getRecord("season_install", job.season_install_id);
    if (g && !g.data.deleted_at) return g.data;
  }
  const p = await readPointer("season-job", job.id);
  if (!p || !isId(p.id, "season_install")) return null;
  const g = await getRecord("season_install", p.id);
  return g && !g.data.deleted_at ? g.data : null;
}

// The status a season should have for its two jobs (pure). A stored or
// cancelled season keeps its status.
export function seasonStatusFor(season, install, takedown) {
  if (["stored", "cancelled"].includes(season.status)) return season.status;
  const t = takedown && takedown.status;
  const i = install && install.status;
  if (t === "completed") return "taken_down";
  if (t === "scheduled" || t === "in_progress") return "takedown_scheduled";
  if (i === "completed") return "installed";
  if (i === "scheduled" || i === "in_progress") return "install_scheduled";
  if (i === "cancelled") return "cancelled";
  return "sold";
}
const dayOf = (iso) => (iso ? localDate(new Date(iso)) : undefined);

// The job listener's part for lights: the season follows its jobs.
export async function syncSeason(season, h) {
  const ids = [season.install_job_id, season.takedown_job_id].filter((x) => isId(x, "job"));
  const got = (await getRecords("job", ids)).filter(Boolean).map((g) => g.data);
  const install = got.find((j) => j.id === season.install_job_id) || null;
  const takedown = got.find((j) => j.id === season.takedown_job_id) || null;
  const st = seasonStatusFor(season, install, takedown);
  const patch = { status: st };
  if (install && install.status === "completed" && !season.installed_on) patch.installed_on = dayOf(install.completed_at);
  if (takedown && takedown.status === "completed" && !season.taken_down_on) patch.taken_down_on = dayOf(takedown.completed_at);
  const changed = Object.entries(patch).some(([k, v]) => v !== undefined && season[k] !== v);
  if (!changed) return { result: "same" };
  if (!h.ctx.mayAct({ record: season })) { await h.ctx.would({ record: season }, "update", { status: [season.status, st] }); return { result: "would-update" }; }
  await updateRecord("season_install", season.id, (s) => ({ ...s, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }), h.ctx.write());
  return { result: `season:${st}` };
}

// A one-time lights install job with no season (a quote converted "this
// season only"): the takedown job and the season record (quote.converted).
export async function seasonForInstallJob(job, h) {
  const contact = (await getRecord("contact", job.contact_id) || {}).data;
  if (!h.ctx.mayAct({ record: job, contact })) { await h.ctx.would({ record: job, contact }, "create", { season_install: 1 }); return { result: "would-create" }; }
  const season = Number(String(job.target_month || localDate(now())).slice(0, 4));
  const out = await createSeason({ contact_id: job.contact_id, property_id: job.property_id, season, quote_id: job.quote_id, deal_id: job.deal_id, lines: job.lines, discounts: [], install_job_id: job.id }, `season-for-job--${job.id}`, h.ctx.write());
  return { result: out.created ? "season:created" : "season:linked" };
}

// ------------------------------------------------------------ the office's actions

export async function getSeason(id) {
  if (!isId(id, "season_install")) throw new NotFoundError("That lights season isn't there.");
  const g = await getRecord("season_install", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That lights season isn't there.");
  return g;
}

// PATCH /lights/installs/:id { bin_id?, footage_ft?, colors?, notes?, cancelled? }:
// a bin on a taken-down season stores it (and the property remembers the bin).
export async function patchSeason(id, body = {}, ctx) {
  const g = await getSeason(id);
  const patch = {};
  if (body.bin_id !== undefined) {
    const b = String(body.bin_id || "").trim();
    if (b.length > 40) throw new InputError("Keep the bin under 40 characters.", "bin_id");
    // the bin is the box the lights go in at takedown: not before they're down
    if (b && !["taken_down", "stored"].includes(g.data.status)) throw new ConflictError("The bin goes on once the lights are taken down.", { code: "not_taken_down" });
    patch.bin_id = b || undefined;
  }
  if (body.footage_ft !== undefined) {
    const n = Number(body.footage_ft);
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw new InputError("Feet from 0 to 100,000.", "footage_ft");
    patch.footage_ft = n;
  }
  if (body.colors !== undefined) {
    if (!Array.isArray(body.colors) || body.colors.some((x) => !LIGHT_COLORS.includes(x))) throw new InputError("Warm white, red or green.", "colors");
    patch.colors = [...new Set(body.colors)];
  }
  if (body.notes !== undefined) patch.notes = String(body.notes || "").slice(0, 2000) || undefined;
  const today = localDate(now());
  const r = await updateRecord("season_install", id, (s) => {
    const next = { ...s, ...patch };
    if (patch.bin_id && s.status === "taken_down") { next.status = "stored"; next.stored_on = today; }
    if (body.cancelled === true && !["taken_down", "stored"].includes(s.status)) next.status = "cancelled";
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return next;
  }, { ...W(ctx), ifMatch: ctx.ifMatch });
  if (patch.bin_id && r.data.status === "stored" && isId(r.data.property_id, "property")) {
    await updateRecord("property", r.data.property_id, (p) => ({ ...p, lights: { total_ft: 0, colors: [], timer: false, runs: [], mockup_file_ids: [], ...(p.lights || {}), bin_id: patch.bin_id, last_season: r.data.season } }), W(ctx))
      .catch((e) => console.error(`crm:plans: property lights not updated (${safeErr(e)})`));
  }
  if (body.cancelled === true && r.changed && r.data.status === "cancelled" && has("work.cancelJobs")) {
    await call("work.cancelJobs", [r.data.install_job_id, r.data.takedown_job_id].filter((x) => isId(x, "job")), "lights season cancelled", `season-cancel--${id}`, W(ctx));
  }
  return r;
}

// POST /lights/installs/:id/warranty: a $0 in-season fix linked to the season.
export async function addWarranty(id, { notes } = {}, ctx) {
  const g = await getSeason(id);
  const s = g.data;
  if (!has("work.createJobs")) throw new ConflictError("Warranty visits arrive with Scheduling.", { code: "not_available" });
  const n = (s.warranty_job_ids || []).length + 1;
  const [jobId] = await call("work.createJobs", [{
    contact_id: s.contact_id, ...(s.property_id ? { property_id: s.property_id } : {}), kind: "lights_warranty", title: `Lights warranty visit ${s.season}`,
    lines: [{ id: "ln_warranty", title: "In-season warranty fix (included)", qty_milli: 1000, unit_cents: 0, service_type: "Christmas Lights" }], discounts: [],
    season_install_id: s.id, billable: false, crew_notes: String(notes || "").slice(0, 2000),
  }], `season-warranty--${s.id}--${n}`, "lights", W(ctx));
  const r = await updateRecord("season_install", s.id, (x) => ((x.warranty_job_ids || []).includes(jobId) ? null : { ...x, warranty_job_ids: [...(x.warranty_job_ids || []), jobId] }), W(ctx));
  return { season: r.data, job_id: jobId };
}

// GET /lights/seasons/:season: the board (rows by status, footage, bins).
export async function seasonBoard(season) {
  const y = Number(season);
  if (!Number.isSafeInteger(y) || y < 2020 || y > 2100) throw new NotFoundError("That season isn't there.");
  const ix = await readIndex("lights", String(y));
  const rows = ix.rows.map((r) => ({ id: r.id, contact_id: r.c, contact_name: r.cn, property_id: r.pr, town: r.tw, status: r.st, footage_ft: r.ft, bin_id: r.bin, colors: r.col, install_job_id: r.ij, takedown_job_id: r.tj, plan_id: r.pl, three_year: r.ty, imported: !!r.im, updated_at: r.u }))
    .sort((a, b) => String(a.contact_name).localeCompare(String(b.contact_name)));
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  return { season: y, rows, counts: by, footage_ft: rows.filter((r) => r.status !== "cancelled").reduce((s, r) => s + (r.footage_ft || 0), 0), needs_bin: rows.filter((r) => r.status === "taken_down" && !r.bin_id).length, to_confirm: await toConfirm(y, rows) };
}

// Lights plans whose season y waits for the customer's yes (no install is
// made before, §5.4): a renewal's season not confirmed yet, or last
// season's customer with nothing for this one.
async function toConfirm(y, rows) {
  const plans = (await readIndex("plans", "")).rows.filter((r) => r.k === "lights_annual" && ["active", "pending", "paused"].includes(r.st));
  const have = new Set(rows.filter((r) => r.status !== "cancelled").map((r) => r.plan_id).filter(Boolean));
  const last = new Set((await readIndex("lights", String(y - 1))).rows.filter((r) => r.pl && r.st !== "cancelled").map((r) => r.pl));
  return plans.filter((r) => !have.has(r.id) && !(r.cs || []).includes(y) && ((r.wc || []).includes(y) || last.has(r.id)))
    .map((r) => ({ plan_id: r.id, contact_id: r.c, contact_name: r.cn || "", town: r.tw || null, plan_name: r.nm }))
    .sort((a, b) => a.contact_name.localeCompare(b.contact_name)).slice(0, 300);
}

// ------------------------------------------------------------ sweeps

// lights.takedown_due (Jan 2, 06:00): last season's installs with no
// takedown job get one (D9); the office hears how many takedowns to book.
export async function takedownDueSweep(ctx) {
  const lights = await loadLights();
  const today = localDate(now());
  if (Number(today.slice(5, 7)) !== (lights.takedown_month || 1)) return { done: true, result: "not_this_month" };
  const season = Number(today.slice(0, 4)) - 1;
  const ix = await readIndex("lights", String(season));
  let made = 0;
  let toBook = 0;
  for (const r of ix.rows) {
    if (ctx.budget && ctx.budget.left() < 15000) return { done: false, progress: made };
    if (!["installed", "install_scheduled"].includes(r.st)) continue;
    if (r.tj) { toBook += 1; continue; }
    const g = await getRecord("season_install", r.id);
    if (!g || g.data.takedown_job_id) continue;
    const s = g.data;
    if (!has("work.createJobs")) continue;
    // a job is the customer's record: the guard asks about the customer, and
    // one refusal never ends the pass (§3.10)
    const cg = await getRecord("contact", s.contact_id).catch(() => null);
    const contact = cg && cg.data;
    if (!ctx.mayAct({ record: s }) || !ctx.mayAct({ record: contact || s, contact })) { await ctx.would({ record: s, contact }, "create", { takedown_job: 1 }); continue; }
    let tj;
    try {
      [tj] = await call("work.createJobs", [{
        contact_id: s.contact_id, ...(s.property_id ? { property_id: s.property_id } : {}), kind: "lights_takedown", title: `Christmas lights takedown ${season}`,
        lines: [{ ...TAKEDOWN_LINE }], discounts: [], target_month: takedownMonth(season, lights), season_install_id: s.id, ...(s.plan_id ? { plan_id: s.plan_id } : {}), billable: false,
      }], `season-takedown--${s.id}`, "lights", ctx.write());
    } catch (e) {
      if (e instanceof ParallelRunGuard) { await ctx.would({ record: s, contact }, "create", { takedown_job: 1 }); continue; }
      throw e;
    }
    await updateRecord("season_install", s.id, (x) => (x.takedown_job_id ? null : { ...x, takedown_job_id: tj }), ctx.write());
    made += 1;
    toBook += 1;
  }
  if (toBook) {
    await notify(await approvers(), { kind: "system", title: "Takedowns to book", body: `${toBook} Christmas lights takedown${toBook === 1 ? "" : "s"} are due this month.`, link: `/lights/${season}` }, ctx.write())
      .catch((e) => console.error(`crm:plans: takedown notice not sent (${safeErr(e)})`));
  }
  return { done: true, result: `takedowns:${made}`, progress: made };
}

// The rebook claim: one rebook bulk run per season, ever.
export async function claimRebook(season) {
  const c = await claimPointer("lights-rebook", String(season), { season });
  return !!c.ok;
}

export { keySafe };
